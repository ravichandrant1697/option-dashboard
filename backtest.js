/**
 * BACKTEST — analyze collected trade history: per-strategy comparison,
 * scorecard, monthly PnL, equity curve, drawdown. Prefers real paper
 * fills from the "Trades" sheet; falls back to simulating from legacy
 * Dashboard rows with a Result column.
 */
const { CAPITAL, LOT_SIZE } = require("./config");
const { SHEETS, loadWorkbookCache } = require("./workbook");

// Load completed trades for the backtest via the same one-time workbook
// cache: prefer real paper fills; fall back to simulated dashboard rows.
function loadTrades() {
  loadWorkbookCache(); // one-time read — backtest analyzes collected history

  const fills = (SHEETS.Trades || []).filter(
    r => (r.Result === "WIN" || r.Result === "LOSS") && isFinite(Number(r.PnL))
  );
  if (fills.length) return { trades: fills, source: "Trades sheet (paper fills)" };

  // Fallback: the legacy cumulative "Dashboard" sheet plus all daily
  // date sheets ("2026-08-05", ...), oldest first.
  const dashRows = [
    ...(SHEETS.Dashboard || []),
    ...Object.keys(SHEETS)
      .filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))
      .sort()
      .flatMap(n => SHEETS[n])
  ];
  if (!dashRows.length) throw new Error("No data in workbook — run the live loop first");
  return {
    trades: dedupeSignals(simulateTrades(dashRows)),
    source: "daily dashboard sheets (simulated)"
  };
}

// Derive PnL and RR from Result + EntryPrice/StopLoss/Target, skipping
// NO TRADE rows.
function simulateTrades(rows) {
  const trades = [];
  for (const r of rows) {
    if (r.Result !== "WIN" && r.Result !== "LOSS") continue;

    const entry = Number(r.EntryPrice);
    const stop = Number(r.StopLoss);
    const target = Number(r.Target);
    if (![entry, stop, target].every(isFinite)) continue;

    const riskPerUnit = entry - stop;
    const rewardPerUnit = target - entry;
    if (riskPerUnit <= 0) continue;

    const qty = (Number(r.Lots) || 1) * LOT_SIZE;
    trades.push({
      ...r,
      PnL: r.Result === "WIN" ? rewardPerUnit * qty : -riskPerUnit * qty,
      RR: rewardPerUnit / riskPerUnit
    });
  }
  return trades;
}

// The live loop appends a row every 60s, so one signal repeats dozens of
// times — keep only the first trade per (day, strategy).
function dedupeSignals(trades) {
  const seen = new Set();
  return trades.filter(t => {
    const key = `${String(t.Timestamp).substring(0, 10)}|${t.Strategy}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// % of trades that hit target (out of completed WIN/LOSS trades only).
function getWinRate(trades) {
  if (!trades.length) return 0;
  return (trades.filter(t => t.Result === "WIN").length / trades.length) * 100;
}

// Gross profit ÷ gross loss. > 1 means the system makes money overall.
function getProfitFactor(trades) {
  let grossProfit = 0;
  let grossLoss = 0;
  for (const t of trades) {
    if (t.PnL > 0) grossProfit += t.PnL;
    else grossLoss += Math.abs(t.PnL);
  }
  if (grossLoss === 0) return grossProfit > 0 ? Infinity : 0;
  return grossProfit / grossLoss;
}

// Mean risk-reward ratio across completed trades.
function getAverageRR(trades) {
  if (!trades.length) return 0;
  return trades.reduce((s, t) => s + (Number(t.RR) || 0), 0) / trades.length;
}

// Deepest peak-to-trough fall of the running equity curve, in ₹.
function getMaxDrawdown(trades) {
  let equity = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of trades) {
    equity += t.PnL;
    if (equity > peak) peak = equity;
    maxDD = Math.max(maxDD, peak - equity);
  }
  return maxDD;
}

// Average ₹ made per trade taken (positive = system has an edge).
function getExpectancy(trades) {
  if (!trades.length) return 0;
  return trades.reduce((s, t) => s + t.PnL, 0) / trades.length;
}

// Cumulative PnL over time: one {date, equity} point per trade.
function buildEquityCurve(trades) {
  let equity = 0;
  return trades.map(t => {
    equity += t.PnL;
    return { date: String(t.Timestamp), equity: Number(equity.toFixed(2)) };
  });
}

// Sum PnL per calendar month (YYYY-MM taken from the entry timestamp).
function groupMonthly(trades) {
  const monthly = {};
  for (const t of trades) {
    const month = String(t.Timestamp).substring(0, 7);
    monthly[month] = Number(((monthly[month] || 0) + t.PnL).toFixed(2));
  }
  return monthly;
}

// Group trades by strategy name → { "Bull Call Spread": [...], ... }.
function getStrategyStats(trades) {
  const map = {};
  for (const t of trades) (map[t.Strategy] = map[t.Strategy] || []).push(t);
  return map;
}

// Compute the full metric set for one list of trades.
function metricsFor(trades) {
  return {
    trades: trades.length,
    winRate: getWinRate(trades),
    profitFactor: getProfitFactor(trades),
    avgRR: getAverageRR(trades),
    expectancy: getExpectancy(trades),
    netPnL: trades.reduce((s, t) => s + t.PnL, 0)
  };
}

// Scorecard 0–100: 40% win rate + 30% profit factor (cap 3) + 30% RR (cap 3).
function scoreStrategy(m) {
  const pf = Math.min(isFinite(m.profitFactor) ? m.profitFactor : 3, 3);
  const rr = Math.min(m.avgRR, 3);
  return Math.round(m.winRate * 0.4 + (pf / 3) * 100 * 0.3 + (rr / 3) * 100 * 0.3);
}

// Format a number to fixed decimals, passing Infinity/NaN through as text.
function fmt(n, digits = 2) {
  return isFinite(n) ? n.toFixed(digits) : String(n);
}

// Full backtest report: per-strategy comparison, scorecard, monthly PnL,
// and the final dashboard summary (win rate, PF, drawdown, best/worst).
function runBacktest() {
  const { trades, source } = loadTrades();
  console.log(`Source: ${source}`);

  if (!trades.length) {
    console.log("No completed trades (WIN/LOSS) found — nothing to backtest.");
    return;
  }

  const overall = metricsFor(trades);
  const byStrategy = getStrategyStats(trades);

  console.log("\n=== Strategy Comparison ===");
  const scorecard = [];
  for (const [name, list] of Object.entries(byStrategy)) {
    const m = metricsFor(list);
    scorecard.push({ Strategy: name, Score: scoreStrategy(m) });
    console.log(
      `${name}\n  Trades: ${m.trades}  Win Rate: ${fmt(m.winRate, 1)}%  ` +
        `Profit Factor: ${fmt(m.profitFactor)}  Avg RR: ${fmt(m.avgRR)}  ` +
        `Expectancy: ₹${fmt(m.expectancy, 0)}/trade\n${"-".repeat(40)}`
    );
  }

  scorecard.sort((a, b) => b.Score - a.Score);
  console.log("\n=== Strategy Scorecard ===");
  console.table(scorecard);

  console.log("=== Monthly PnL ===");
  console.table(groupMonthly(trades));

  const curve = buildEquityCurve(trades);
  const finalEquity = curve.length ? curve[curve.length - 1].equity : 0;

  console.log("=== Final Dashboard Output ===");
  console.log(`Capital:        ₹${CAPITAL.toLocaleString("en-IN")}`);
  console.log(`Trades:         ${overall.trades}`);
  console.log(`Win Rate:       ${fmt(overall.winRate)}%`);
  console.log(`Profit Factor:  ${fmt(overall.profitFactor)}`);
  console.log(`Average RR:     ${fmt(overall.avgRR)}`);
  console.log(`Expectancy:     ₹${fmt(overall.expectancy, 0)} per trade`);
  console.log(`Net PnL:        ₹${fmt(overall.netPnL, 0)}`);
  console.log(`Max Drawdown:   ₹${fmt(getMaxDrawdown(trades), 0)}`);
  console.log(`Final Equity:   ₹${fmt(CAPITAL + finalEquity, 0)}`);
  console.log(`Best Strategy:  ${scorecard[0]?.Strategy}`);
  console.log(`Worst Strategy: ${scorecard[scorecard.length - 1]?.Strategy}`);
}

module.exports = { runBacktest };
