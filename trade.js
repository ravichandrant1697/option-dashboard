/**
 * TRADE — the position lifecycle: plan → open → close, plus live order
 * execution (opt-in). The paper journal (Trades sheet) is always written;
 * live mode ADDS real orders on top.
 */
const {
  LOT_SIZE,
  RULES,
  CONFIG,
  MIN_EDGE_MULTIPLE,
  OI_STRONG_RATIO,
  BLOCK_NAKED_LEGS
} = require("./config");
const { daysUntil, istTimestamp } = require("./clock");
const { getActiveHorizon } = require("./horizons");
const runtime = require("./runtime");
const { placeOrder, fetchQuotes } = require("./upstox-api");
const { notify } = require("./notify");
const { getState, saveState } = require("./state");
const { recommend, toLegs } = require("./strategies");
const {
  getNetPremium,
  exitLevels,
  getLots,
  getNetGreek,
  estimateRoundTripCharges
} = require("./pricing");
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
//
// SIGNAL vs EXECUTION: a valid signal is ALWAYS priced and returned so the
// journal keeps its entry-signal columns every tick — expiry day included.
// Execution-only gates (DTE, theta, same-legs, cost floor) don't kill the
// plan; they set plan.blocked with the reason, the Dashboard row records
// it in the Blocked column, and the engine refuses to open the position.
// Returns null only when there is no signal to price at all (confidence
// below the filter, no strategy, no quote). Async since 2026-08-20: the
// depth gate fetches live bid/ask for the legs before approving an entry.
async function buildTradePlan(result, chain) {
  if (result.confidence < RULES.minConfidence) return null; // trade filter

  const horizon = getActiveHorizon();
  const candleTrend = runtime.getCandleTrend();
  let blocked = null; // first tripped execution gate wins

  // Execution gate — the chosen expiry must leave room to actually HOLD:
  // intraday minEntryDTE 1 keeps expiry-day (DTE 0) positions off — the
  // recorded expiry-day signal was a coin flip (41–55%) while IV/theta
  // readings blew up; a 4-DTE weekly cannot host a one-month positional
  // view either (positional needs ≥ 10).
  if (horizon.minEntryDTE) {
    const dte = daysUntil(CONFIG.expiryDate);
    if (dte < horizon.minEntryDTE) {
      blocked = `expiry ${dte}d away < min ${horizon.minEntryDTE}d (${horizon.name})`;
      console.log(`⛔ ENTRY gate (${horizon.name}): ${blocked} — signal still logged`);
    }
  }

  // Execution gate (entry persistence): the bias must have held for
  // entryBiasPersistence consecutive polls — the entry-side mirror of the
  // SIGNAL_CHANGE exit rule. Entries used to fire on a single poll's bias:
  // on the 2026-08-14 chop day (bias flipped ~60×/117 polls) that entered
  // trades on 1- and 2-poll blips inside opposite-bias stretches. The
  // engine updates the streak (state.trackBiasStreak) before building the
  // plan, so the current poll counts toward it.
  const streak = getState().biasStreak || { bias: null, count: 0 };
  if (!blocked && (streak.bias !== result.bias || streak.count < RULES.entryBiasPersistence)) {
    const seen = streak.bias === result.bias ? streak.count : 0;
    blocked = `bias ${result.bias} persisted ${seen}/${RULES.entryBiasPersistence} polls`;
    console.log(`⛔ ENTRY gate (persistence): ${blocked} — signal still logged`);
  }

  // Tuning gate: skip counter-trend entries when history showed they lose
  if (tuning.requireTrendMatch && candleTrend !== null) {
    const matches =
      (result.bias === "Bullish" && candleTrend === "Up") ||
      (result.bias === "Bearish" && candleTrend === "Down") ||
      (result.bias === "Range" && candleTrend === "Flat");
    if (!matches) return null;
  }

  // Execution gate (day-anchor alignment): a directional entry must sit on
  // the day-drift side of the anchor — Bearish only below it, Bullish only
  // above. The anchor is today's VWAP when candle data is in (the proper
  // intraday value anchor: volume-weighted, not just the first print),
  // falling back to the session's first spot reading. Signals against the
  // day's drift were the bleed: persisted-Bearish reads on the wrong side
  // flipped from 67% to 27% accurate. Range entries exempt.
  const vwap = runtime.getVwap();
  const anchor = vwap ?? getState().dayOpenSpot;
  const anchorName = vwap != null ? "VWAP" : "day open";
  // Compare in the SAME instrument space as the anchor: a futures-sourced
  // VWAP (index underlyings — see signals.js) is compared against the
  // futures price (vwapRef), never index spot, because futures carry a
  // basis over spot that would tilt the gate.
  const anchorPrice = (vwap != null && runtime.getVwapRef() != null) ? runtime.getVwapRef() : result.spot;
  if (!blocked && RULES.dayOpenAlignment && anchor != null && result.bias !== "Range") {
    const aligned =
      (result.bias === "Bullish" && anchorPrice > anchor) ||
      (result.bias === "Bearish" && anchorPrice < anchor);
    if (!aligned) {
      blocked = `bias ${result.bias} vs ${anchorPrice} on wrong side of ${anchorName} ${anchor}`;
      console.log(`⛔ ENTRY gate (day-anchor alignment): ${blocked} — signal still logged`);
    }
  }

  // Execution gate (volume surge): a directional move without volume was
  // the recorded trap — low-volume drifts mean-reverted. Needs the latest
  // 5-min candle volume ≥ volumeSurgeMin × the day's average; the check
  // drops out while candle history is too short (surge null) or when
  // volumeSurgeMin is 0.
  const surge = runtime.getVolumeSurge();
  if (!blocked && RULES.volumeSurgeMin && surge != null && result.bias !== "Range" &&
      surge < RULES.volumeSurgeMin) {
    blocked = `volume ${surge}× avg < ${RULES.volumeSurgeMin}× required`;
    console.log(`⛔ ENTRY gate (volume surge): ${blocked} — signal still logged`);
  }

  // Execution gate (futures build-up): the near-month future is ONE clean
  // price+OI series — when its flow contradicts the option-chain bias
  // (e.g. Long Buildup while the chain reads Bearish), trust the future
  // and stand down. Inactive without CONFIG.futuresKey / quote history;
  // a Neutral read passes.
  const fut = runtime.getFuturesBuildup();
  if (!blocked && fut && fut.direction !== "Neutral" && result.bias !== "Range" &&
      fut.direction !== result.bias) {
    blocked = `futures ${fut.label} (${fut.direction}) contradicts ${result.bias} bias`;
    console.log(`⛔ ENTRY gate (futures build-up): ${blocked} — signal still logged`);
  }

  // Best-scored strategy that tuning hasn't blocked (falls through to the
  // #2 / #3 strategy when the top one has proven negative expectancy).
  // Naked long options are blocked STRUCTURALLY on the stock engine
  // (BLOCK_NAKED_LEGS): 0 wins in 8 journal trades, −₹5,133 — and the
  // tuner's own blocklist resets whenever the regime date moves.
  const NAKED_STRATEGIES = ["Buy Call", "Buy Put"];
  const chosen = [result.strategy1, result.strategy2, result.strategy3]
    .filter(Boolean)
    .find(
      s =>
        !tuning.blockedStrategies.includes(s) &&
        !(BLOCK_NAKED_LEGS && NAKED_STRATEGIES.includes(s))
    );
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

  // Conviction mode from the OI flow behind this signal:
  //   dominant side ≥ OI_STRONG_RATIO (2.5×) → "ride": no fixed target,
  //   the signal reversal takes the profit. Limited support → "scalp":
  //   bank the premium-relative band (SCALP_TARGET_PCT). Range structures
  //   keep the % rule.
  // NAKED legs (single leg) always scalp, never ride — their trigger
  // already requires ≥ 2.5× dominance, so without this they would always
  // ride; the point of a naked ATM option here is the quick band take,
  // not holding unhedged theta/vega until the flow reverses. (Moot while
  // BLOCK_NAKED_LEGS keeps single legs out entirely.)
  const dominance =
    result.bias === "Bullish" ? result.bullishOI / Math.max(1, result.bearishOI) :
    result.bias === "Bearish" ? result.bearishOI / Math.max(1, result.bullishOI) : 0;
  const exitMode =
    legs.length === 1 ? "scalp" :
    result.bias === "Range" ? "default" :
    dominance >= OI_STRONG_RATIO ? "ride" : "scalp";
  const { stopDist, targetDist, lockDist } = exitLevels(netEntry, exitMode, legs.length === 1);
  // Reference capture for gates that need a number in ride mode (no fixed
  // target). 1R (stopDist), NOT stop × RISK_REWARD: rides exit on signal
  // reversal, and the journal shows their realized capture is nowhere near
  // 2R — pricing the cost floor off an aspirational 2R let structurally
  // unprofitable trades (₹37 typical move vs ₹118 charges) through.
  const refTarget = targetDist ?? stopDist;

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
      const cap = refTarget * 0.5;
      console.log(
        `⏳ THETA gate (${horizon.name}): net θ ${netTheta.toFixed(2)}/day × ` +
          `${horizon.plannedHoldDays}d = −${projectedDecay.toFixed(2)} vs cap ${cap.toFixed(2)}`
      );
      if (projectedDecay > cap) {
        blocked = blocked ?? `theta decay ${projectedDecay.toFixed(1)} > cap ${cap.toFixed(1)} (${horizon.name})`;
        console.log(`⛔ ENTRY gate (${horizon.name}): theta decay would eat the edge — signal still logged`);
      }
    }
  }

  const lots = getLots(netEntry, stopDist);

  // Execution gate (churn): never re-enter a structure already traded
  // today. The first live days show exits re-entered into the IDENTICAL
  // legs 1–3 minutes later — each lap cost ~₹100 in charges to reprice
  // the same idea. A new ATM (spot moved a strike) builds different legs
  // and passes naturally.
  const summary = legsSummary(legs);
  if (!blocked && getState().closedToday.some(t => t.Legs === summary)) {
    blocked = "same legs already traded today";
    console.log(`⛔ ENTRY gate: ${summary} already traded today — signal still logged`);
  }

  // Execution gate (cost floor): reward at full target must be ≥
  // MIN_EDGE_MULTIPLE × the estimated Upstox round-trip charges. At 1 lot
  // the flat brokerage+GST (~₹94) alone is ~1.45 premium points — trades
  // whose target can't clearly beat that are donations to the broker.
  const estCharges = estimateRoundTripCharges(chain, legs, lots || 1);
  if (estCharges !== null && !blocked) {
    const reward = refTarget * LOT_SIZE * (lots || 1);
    if (reward < MIN_EDGE_MULTIPLE * estCharges) {
      blocked = `reward ₹${reward.toFixed(0)} < ${MIN_EDGE_MULTIPLE}× charges ₹${estCharges.toFixed(0)}`;
      console.log(`⛔ ENTRY gate (cost floor): ${blocked} — signal still logged`);
    }
  }

  // Execution gate (depth): the LAST gate, and the only one that costs an
  // API call — so it runs only when everything else already passed. Sums
  // each leg's half-spread ((ask − bid) / 2 = the slippage of a market
  // order vs mid); stock-option books are wide enough (₹0.3–1 on a ₹5–10
  // leg) to eat the whole edge before the market moves. Missing depth or
  // a failed quote SKIPS the gate (paper mode still works offline).
  if (!blocked && RULES.maxSpreadCostFrac && (lots || 1) >= 1) {
    const keys = legs.map(l => l.instrument_key).filter(Boolean);
    if (keys.length === legs.length) {
      try {
        const quotes = await fetchQuotes(keys);
        let spreadCost = 0;
        let covered = true;
        for (const leg of legs) {
          const d = quotes.get(leg.instrument_key)?.depth;
          const bid = d?.buy?.[0]?.price;
          const ask = d?.sell?.[0]?.price;
          if (!bid || !ask || ask <= bid) { covered = false; break; }
          spreadCost += (ask - bid) / 2;
        }
        if (covered && spreadCost > RULES.maxSpreadCostFrac * refTarget) {
          blocked =
            `bid-ask cost ${spreadCost.toFixed(2)} pts > ` +
            `${RULES.maxSpreadCostFrac}× target ${refTarget.toFixed(2)}`;
          console.log(`⛔ ENTRY gate (depth): ${blocked} — signal still logged`);
        }
      } catch (e) {
        console.log(`⏭️ Depth gate skipped — quote failed: ${e.response?.status || e.message}`);
      }
    }
  }

  return { rec, legs, netEntry, stopDist, targetDist, lockDist, exitMode, lots, estCharges: estCharges ?? 0, blocked };
}

// Open a paper position: store it in the in-memory state, record the
// entry IMMEDIATELY as an OPEN row in the "Trades" sheet (completed with
// exit data by closePosition), and send an alert.
async function openPosition(result, plan) {
  const horizon = getActiveHorizon();
  const pos = {
    id: Date.now(),
    openedAt: istTimestamp(),  // IST wall clock — journal display format
    openedAtMs: Date.now(),    // epoch ms — ALL duration math uses this
    strategy: plan.rec.strategy,
    legs: plan.legs,
    lots: plan.lots,
    netEntry: plan.netEntry,
    stopDist: plan.stopDist,
    targetDist: plan.targetDist, // null = ride mode (no fixed target)
    lockDist: plan.lockDist ?? null, // scalp only: premium-relative profit floor
    exitMode: plan.exitMode,     // ride | scalp | default — journaled for tuning
    estCharges: plan.estCharges, // Upstox round-trip estimate, deducted at close
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
    GrossPnL: "",
    Charges: pos.estCharges ?? 0,
    PnL: "",
    ExitMode: pos.exitMode ?? "",
    RR: pos.targetDist != null && pos.stopDist > 0
      ? Number((pos.targetDist / pos.stopDist).toFixed(2))
      : "", // ride mode has no fixed target, so no RR
    Confidence: pos.confidence,
    EntryBias: result.bias,
    TrendAtEntry: pos.trendAtEntry ?? ""
  });

  // Live mode: fire the real entry orders (paper journal runs regardless)
  await executeLegs(pos, true);

  await notify(
    `🟢 PAPER ENTRY [${pos.horizon}] ${pos.strategy} ${legsSummary(pos.legs)} x${pos.lots} lot(s) @ net ` +
      `${pos.netEntry.toFixed(2)} | stop -${pos.stopDist.toFixed(2)} ` +
      `| ${pos.targetDist != null ? `target +${pos.targetDist.toFixed(2)}` : "RIDE (exit on signal reversal)"}` +
      `${pos.lockDist != null ? ` (lock +${pos.lockDist.toFixed(0)})` : ""}` +
      ` | conf ${pos.confidence} | exp ${pos.expiry}`
  );
}

// Close a paper position: compute PnL, move it to closedToday in the
// in-memory state, complete the OPEN row written at entry (the
// backtester's input) with the outcome AND the exit reason, and alert.
async function closePosition(pos, netNow, outcome, reason) {
  if (runtime.closingIds.has(pos.id)) return; // already closing (stream/poll race)
  runtime.closingIds.add(pos.id);

  const qty = pos.lots * LOT_SIZE;
  // PnL is NET of the estimated Upstox round-trip charges (see COSTS in
  // config.js) — the tuner and backtester read PnL, so they learn from
  // what actually lands in the account, not the gross premium move.
  const gross = (netNow - pos.netEntry) * qty;
  const chargesRs = pos.estCharges ?? 0;
  const trade = {
    PosId: pos.id,
    Timestamp: pos.openedAt,
    ExitTime: istTimestamp(),
    Horizon: pos.horizon ?? "",
    Expiry: pos.expiry ?? "",
    Strategy: pos.strategy,
    Legs: legsSummary(pos.legs),
    Lots: pos.lots,
    NetEntry: Number(pos.netEntry.toFixed(2)),
    NetExit: Number(netNow.toFixed(2)),
    Result: outcome,
    ExitReason: reason,
    GrossPnL: Number(gross.toFixed(2)),
    Charges: chargesRs,
    PnL: Number((gross - chargesRs).toFixed(2)),
    ExitMode: pos.exitMode ?? "",
    RR: pos.targetDist != null && pos.stopDist > 0
      ? Number((pos.targetDist / pos.stopDist).toFixed(2))
      : "", // ride mode has no fixed target, so no RR
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
      `${outcome} (${reason}) | PnL ₹${trade.PnL} (gross ₹${trade.GrossPnL} − charges ₹${chargesRs})`
  );
  runtime.closingIds.delete(pos.id);
}

module.exports = { executeLegs, buildTradePlan, openPosition, closePosition };
