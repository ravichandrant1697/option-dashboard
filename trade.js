/**
 * TRADE — the position lifecycle: plan → open → close, plus live order
 * execution (opt-in). The paper journal (Trades sheet) is always written;
 * live mode ADDS real orders on top.
 */
const { LOT_SIZE, RULES, CONFIG } = require("./config");
const { daysUntil } = require("./clock");
const { getActiveHorizon } = require("./horizons");
const runtime = require("./runtime");
const { placeOrder } = require("./upstox-api");
const { notify } = require("./notify");
const { getState, saveState } = require("./state");
const { recommend, toLegs } = require("./strategies");
const { getNetPremium, exitLevels, getLots, getNetGreek } = require("./pricing");
const { SHEETS, appendRow, flushWorkbook } = require("./workbook");
const { tuning } = require("./tuning");

// Human-readable leg summary, e.g. "BUY 24800CE | SELL 24900CE" — same
// format as the Excel Legs column, reused in Telegram alerts.
function legsSummary(legs) {
  return legs.map(l => `${l.side} ${l.strike}${l.type}`).join(" | ");
}

// Execute all legs of a position as market orders. entry=true places the
// legs as defined; entry=false reverses BUY↔SELL to square off. BUY
// orders go first (hedge-first: margin benefit and safety). A failed leg
// is reported and the rest continue — ALWAYS verify partial fills in the
// broker terminal.
async function executeLegs(pos, entry) {
  if (!runtime.isLiveTrading()) return;
  const qty = pos.lots * LOT_SIZE;

  const orders = pos.legs
    .map(leg => ({ leg, side: entry ? leg.side : leg.side === "BUY" ? "SELL" : "BUY" }))
    .sort((a, b) => (a.side === "BUY" ? 0 : 1) - (b.side === "BUY" ? 0 : 1));

  for (const { leg, side } of orders) {
    if (!leg.instrument_key) {
      await notify(
        `⚠️ LIVE order skipped (${pos.strategy}): no instrument_key for ${leg.strike}${leg.type}`
      );
      continue;
    }
    try {
      // product recorded at entry: "I" intraday, "D" positional/swing
      const orderId = await placeOrder(leg.instrument_key, side, qty, pos.product || "I");
      await notify(`📮 LIVE ${side} ${leg.strike}${leg.type} x${qty} → order ${orderId}`);
    } catch (e) {
      await notify(
        `❌ LIVE order FAILED ${side} ${leg.strike}${leg.type}: ` +
          `${JSON.stringify(e.response?.data || e.message)}`
      );
    }
  }
}

// Turn the analysis into an executable plan: apply the confidence filter,
// build the top strategy's legs, price them, derive stop/target and lots.
// Returns null when there is nothing tradeable this tick.
function buildTradePlan(result, chain) {
  if (result.confidence < RULES.minConfidence) return null; // trade filter

  const horizon = getActiveHorizon();
  const candleTrend = runtime.getCandleTrend();

  // Multi-day horizons: the chosen expiry must leave room to actually
  // HOLD — a 4-DTE weekly cannot host a one-month positional view.
  // Sample: positional (minEntryDTE 10) + expiry 2026-08-11 on Aug 7
  //   → DTE 4 → ⛔ blocked; expiry 2026-09-08 → DTE 32 → passes.
  if (horizon.minEntryDTE) {
    const dte = daysUntil(CONFIG.expiryDate);
    if (dte < horizon.minEntryDTE) {
      console.log(
        `⛔ ENTRY blocked (${horizon.name}): expiry ${CONFIG.expiryDate} is only ` +
          `${dte}d away — needs ≥ ${horizon.minEntryDTE}d. Pick a farther (monthly) expiry.`
      );
      return null;
    }
  }

  // Tuning gate: skip counter-trend entries when history showed they lose
  if (tuning.requireTrendMatch && candleTrend !== null) {
    const matches =
      (result.bias === "Bullish" && candleTrend === "Up") ||
      (result.bias === "Bearish" && candleTrend === "Down") ||
      (result.bias === "Range" && candleTrend === "Flat");
    if (!matches) return null;
  }

  // Best-scored strategy that tuning hasn't blocked (falls through to the
  // #2 / #3 strategy when the top one has proven negative expectancy)
  const chosen = [result.strategy1, result.strategy2, result.strategy3]
    .filter(Boolean)
    .find(s => !tuning.blockedStrategies.includes(s));
  if (!chosen) return null;

  const rec = recommend(chosen, result.atmStrike);
  if (!rec) return null;

  const legs = toLegs(rec);
  if (!legs.length) return null;

  const netEntry = getNetPremium(chain, legs);
  if (netEntry === null || netEntry === 0) return null;

  // Attach instrument keys to the legs — needed for live orders and for
  // streamed ticks. The flat chain may not carry keys; live orders then
  // skip that leg and the stream falls back to polled prices.
  for (const leg of legs) {
    const row = chain.find(r => r.strike_price === leg.strike);
    const side = leg.type === "CE" ? row?.call_options : row?.put_options;
    leg.instrument_key = side?.instrument_key || null;
  }

  const { stopDist, targetDist } = exitLevels(netEntry);

  // Theta gate (multi-day horizons, DEBIT structures only): time decay
  // over the planned hold must not eat more than half the target move —
  // the playbook ranks theta with delta as the greeks that matter.
  // Net structure theta = θ(buy legs) − θ(sell legs), so a spread's decay
  // is the small DIFFERENCE, not one option's raw theta.
  // Sample: net θ −0.8/day × 10d planned = −8 vs target +20 → cap 10 → OK;
  //         net θ −1.5/day × 10d = −15 > 10 → ⛔ blocked.
  if (horizon.plannedHoldDays && netEntry > 0) {
    const netTheta = getNetGreek(chain, legs, "theta");
    if (netTheta !== null) {
      const projectedDecay = Math.max(0, -netTheta) * horizon.plannedHoldDays;
      const cap = targetDist * 0.5;
      console.log(
        `⏳ THETA gate (${horizon.name}): net θ ${netTheta.toFixed(2)}/day × ` +
          `${horizon.plannedHoldDays}d = −${projectedDecay.toFixed(2)} vs cap ${cap.toFixed(2)}`
      );
      if (projectedDecay > cap) {
        console.log(`⛔ ENTRY blocked (${horizon.name}): theta decay would eat the edge`);
        return null;
      }
    }
  }

  const lots = getLots(netEntry, stopDist);

  return { rec, legs, netEntry, stopDist, targetDist, lots };
}

// Open a paper position: store it in the in-memory state, record the
// entry IMMEDIATELY as an OPEN row in the "Trades" sheet (completed with
// exit data by closePosition), and send an alert.
async function openPosition(result, plan) {
  const horizon = getActiveHorizon();
  const pos = {
    id: Date.now(),
    openedAt: new Date().toISOString(),
    strategy: plan.rec.strategy,
    legs: plan.legs,
    lots: plan.lots,
    netEntry: plan.netEntry,
    stopDist: plan.stopDist,
    targetDist: plan.targetDist,
    confidence: result.confidence,
    entryBias: result.bias, // signal-change exit compares against this
    trendAtEntry: runtime.getCandleTrend(), // recorded so tuning can learn from it
    horizon: horizon.name,          // intraday | positional | swing
    product: horizon.product,       // "I" or "D" — used by live orders
    expiry: CONFIG.expiryDate       // EXPIRY_STOP measures DTE against this
  };
  getState().open.push(pos);

  // Entry record — visible in Excel from the moment the trade opens.
  appendRow("Trades", {
    PosId: pos.id,
    Timestamp: pos.openedAt,
    ExitTime: "",
    Horizon: pos.horizon,
    Expiry: pos.expiry,
    Strategy: pos.strategy,
    Legs: legsSummary(pos.legs),
    Lots: pos.lots,
    NetEntry: Number(pos.netEntry.toFixed(2)),
    NetExit: "",
    Result: "OPEN",
    ExitReason: "",
    PnL: "",
    RR: pos.stopDist > 0 ? Number((pos.targetDist / pos.stopDist).toFixed(2)) : 0,
    Confidence: pos.confidence,
    EntryBias: result.bias,
    TrendAtEntry: pos.trendAtEntry ?? ""
  });

  // Live mode: fire the real entry orders (paper journal runs regardless)
  await executeLegs(pos, true);

  await notify(
    `🟢 PAPER ENTRY [${pos.horizon}] ${pos.strategy} ${legsSummary(pos.legs)} x${pos.lots} lot(s) @ net ` +
      `${pos.netEntry.toFixed(2)} | stop -${pos.stopDist.toFixed(2)} ` +
      `| target +${pos.targetDist.toFixed(2)} | conf ${pos.confidence} | exp ${pos.expiry}`
  );
}

// Close a paper position: compute PnL, move it to closedToday in the
// in-memory state, complete the OPEN row written at entry (the
// backtester's input) with the outcome AND the exit reason, and alert.
async function closePosition(pos, netNow, outcome, reason) {
  if (runtime.closingIds.has(pos.id)) return; // already closing (stream/poll race)
  runtime.closingIds.add(pos.id);

  const qty = pos.lots * LOT_SIZE;
  const trade = {
    PosId: pos.id,
    Timestamp: pos.openedAt,
    ExitTime: new Date().toISOString(),
    Horizon: pos.horizon ?? "",
    Expiry: pos.expiry ?? "",
    Strategy: pos.strategy,
    Legs: legsSummary(pos.legs),
    Lots: pos.lots,
    NetEntry: Number(pos.netEntry.toFixed(2)),
    NetExit: Number(netNow.toFixed(2)),
    Result: outcome,
    ExitReason: reason,
    PnL: Number(((netNow - pos.netEntry) * qty).toFixed(2)),
    RR: pos.stopDist > 0 ? Number((pos.targetDist / pos.stopDist).toFixed(2)) : 0,
    Confidence: pos.confidence,
    EntryBias: pos.entryBias,
    TrendAtEntry: pos.trendAtEntry ?? ""
  };

  const state = getState();
  state.open = state.open.filter(p => p.id !== pos.id);
  state.closedToday.push(trade);

  // Update the entry's OPEN row in place; append only if it is missing.
  const openRow = SHEETS.Trades.find(r => r.PosId === pos.id);
  if (openRow) Object.assign(openRow, trade);
  else SHEETS.Trades.push(trade);
  flushWorkbook();
  saveState(); // stream-driven closes must persist immediately too

  // Live mode: square off the real legs (reversed orders)
  await executeLegs(pos, false);

  await notify(
    `${outcome === "WIN" ? "✅" : "🔴"} PAPER EXIT ${pos.strategy} ${legsSummary(pos.legs)} ` +
      `${outcome} (${reason}) | PnL ₹${trade.PnL}`
  );
  runtime.closingIds.delete(pos.id);
}

module.exports = { executeLegs, buildTradePlan, openPosition, closePosition };
