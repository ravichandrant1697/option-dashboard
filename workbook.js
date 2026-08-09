/**
 * WORKBOOK — the Excel journal. In-memory cache of every sheet, loaded
 * once at startup, WRITE-ONLY afterwards. Market data is DATE-SCOPED:
 * each trading day writes to its own sheet named by IST date (e.g.
 * "2026-08-05"); Trades/Portfolio/Positions stay cumulative because the
 * backtester and tuner need the full history in one place.
 */
const XLSX = require("xlsx");
const fs = require("fs");
const { FILE_NAME, CAPITAL, LOT_SIZE } = require("./config");
const { todayIST } = require("./clock");

const SHEETS = { Trades: [], Portfolio: [], Positions: [] };

// Name of today's market-data sheet — a new sheet starts each day.
function dashboardSheetName() {
  return todayIST();
}

// One-time startup read of ALL existing workbook sheets into the memory
// cache — including previous days' date sheets, so a flush never drops
// them. Never called on the hot path.
function loadWorkbookCache() {
  if (!fs.existsSync(FILE_NAME)) return;
  const workbook = XLSX.readFile(FILE_NAME);
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (sheet) SHEETS[name] = XLSX.utils.sheet_to_json(sheet);
  }
}

// Write the whole workbook to disk from the in-memory cache — pure write,
// no file read during the trading day.
function flushWorkbook() {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(SHEETS)) {
    if (rows.length)
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
  }
  XLSX.writeFile(workbook, FILE_NAME);
}

// Append a row to the in-memory sheet (created on first use — e.g. a
// new day's date sheet) and flush the workbook to disk.
function appendRow(sheetName, row) {
  (SHEETS[sheetName] = SHEETS[sheetName] || []).push(row);
  flushWorkbook();
}

// Flatten one analysis tick (+ optional trade plan) into a Dashboard row —
// all analysis columns plus the recommendation columns when a plan passed
// the filters. NO TRADE rows carry the analysis only.
function toDashboardRow(result, plan) {
  const base = {
    Timestamp: result.timestamp,
    Spot: result.spot,
    ATMStrike: result.atmStrike,
    PCR: result.pcr,
    S1: result.S1, S2: result.S2, S3: result.S3,
    R1: result.R1, R2: result.R2, R3: result.R3,
    BullishCount: result.bullishCount,
    BearishCount: result.bearishCount,
    BullishOI: result.bullishOI,
    BearishOI: result.bearishOI,
    Buildup: result.buildupSummary,
    AvgIV: result.avgIV,
    Bias: result.bias,
    AvgCallDelta: result.avgCallDelta,
    AvgPutDelta: result.avgPutDelta,
    AvgTheta: result.avgTheta,
    AvgGamma: result.avgGamma,
    AvgVega: result.avgVega,
    CandleTrend: result.candleTrend ?? "",
    Confidence: result.confidence,
    Strategy1: result.strategy1,
    Strategy1Score: result.strategy1Score,
    Strategy2: result.strategy2,
    Strategy2Score: result.strategy2Score,
    Strategy3: result.strategy3,
    Strategy3Score: result.strategy3Score,
    Capital: CAPITAL
  };

  if (!plan) return { ...base, Strategy: "NO TRADE" };

  return {
    ...base,
    Strategy: plan.rec.strategy,
    Legs: plan.legs.map(l => `${l.side} ${l.strike}${l.type}`).join(" | "),
    Lots: plan.lots,
    EntryPrice: Number(plan.netEntry.toFixed(2)),
    StopLoss: Number((plan.netEntry - plan.stopDist).toFixed(2)),
    Target: Number((plan.netEntry + plan.targetDist).toFixed(2)),
    Risk: Number((plan.stopDist * LOT_SIZE * plan.lots).toFixed(0)),
    Reward: Number((plan.targetDist * LOT_SIZE * plan.lots).toFixed(0)),
    RiskRewardRatio:
      plan.stopDist > 0 ? Number((plan.targetDist / plan.stopDist).toFixed(2)) : 0
  };
}

module.exports = {
  SHEETS,
  dashboardSheetName,
  loadWorkbookCache,
  flushWorkbook,
  appendRow,
  toDashboardRow
};
