/**
 * PRICING — structure pricing, exit levels/decisions, and position sizing.
 * Everything here works on the NET premium of a whole structure
 * (Σ buy LTPs − Σ sell LTPs), never on individual legs.
 */
const {
  STOP_PCT,
  RISK_REWARD,
  SCALP_TARGET_PCT,
  SCALP_LOCK_PCT,
  MAX_RISK,
  LOT_SIZE,
  MAX_LOTS,
  CAPITAL,
  MARGIN_PER_CREDIT_LOT,
  COSTS
} = require("./config");
const { isSquareOffTime, daysUntil, nowIST } = require("./clock");
const { getActiveHorizon } = require("./horizons");
const { liveTicks } = require("./runtime");

// Last traded price of one option (strike + CE/PE). Prefers a fresh
// streamed tick (< 15s old) when the WebSocket is connected; falls back
// to the polled chain value.
function getLtp(chain, strike, type) {
  const row = chain.find(r => r.strike_price === strike);
  if (!row) return null;
  const side = type === "CE" ? row.call_options : row.put_options;
  const streamed = side?.instrument_key ? liveTicks.get(side.instrument_key) : null;
  if (streamed && streamed.ltp !== null && Date.now() - streamed.at < 15000) {
    return streamed.ltp;
  }
  return side?.market_data?.ltp ?? null;
}

// netPremium = Σ(buy LTPs) − Σ(sell LTPs).
// Positive = debit strategy (spreads/straddle), negative = credit (condor).
// Per-unit PnL = netNow − netEntry works for BOTH cases.
function getNetPremium(chain, legs) {
  let net = 0;
  for (const leg of legs) {
    const ltp = getLtp(chain, leg.strike, leg.type);
    if (ltp === null) return null; // strike missing from chain — don't guess
    net += leg.side === "BUY" ? ltp : -ltp;
  }
  return net;
}

// Exit levels by CONVICTION MODE (see OI_STRONG_RATIO in config):
//   "ride"    strong OI dominance — targetDist null = NO fixed target;
//             the SIGNAL_CHANGE reversal takes the profit, the stop still
//             protects. (null, not Infinity: positions.json round-trips
//             null safely; JSON turns Infinity into null anyway, but then
//             a restart would compare move >= null — always true — and
//             instantly close every ride position as a TARGET win.)
//   "scalp"   bank a premium-relative band: target SCALP_TARGET_PCT (20%)
//             of |net entry|, stop = target / RISK_REWARD keeps 1:2, and
//             lockDist = SCALP_LOCK_PCT (10%) — once the move has SEEN
//             +lock, a pullback to that level exits PROFIT_LOCK instead of
//             letting the win round-trip back to the stop. Percentages,
//             not points: absolute 10/5-pt bands were NIFTY premium scale
//             and unreachable on a ~₹4–13 stock structure.
//   "default" Range structures — stop = STOP_PCT (50%) of net premium,
//             target = RISK_REWARD (2) × stop (credit: full decay).
// Naked legs keep the tight scalp stop in every mode — a 50% stop on a
// naked ATM option is far too deep a drawdown.
function exitLevels(netEntry, mode = "default", nakedLeg = false) {
  const scalpTarget = Math.abs(netEntry) * SCALP_TARGET_PCT;
  const stopDist =
    nakedLeg || mode === "scalp"
      ? scalpTarget / RISK_REWARD
      : Math.abs(netEntry) * STOP_PCT;
  const targetDist =
    mode === "ride" ? null :
    mode === "scalp" ? scalpTarget :
    stopDist * RISK_REWARD;
  const lockDist = mode === "scalp" ? Math.abs(netEntry) * SCALP_LOCK_PCT : null;
  return { stopDist, targetDist, lockDist };
}

// Exit decision for an open position, horizon-aware. Priority order:
//   STOP → TARGET → PROFIT_LOCK → TIME_STOP → EXPIRY_STOP →
//   SIGNAL_CHANGE → SQUARE_OFF.
//
//   TIME_STOP      position held past the horizon's maxHoldDays
//                  (positional 30d, swing 90d — the playbook's limits)
//   EXPIRY_STOP    expiry within exitBufferDays — get out BEFORE the
//                  gamma/theta cliff (playbook: greeks stop mattering
//                  on expiry day)
//   SIGNAL_CHANGE  bias REVERSED (Bullish↔Bearish) for signalPersistence
//                  CONSECUTIVE polls. Drift to Range does NOT count: the
//                  signal log shows bias wobbling Bearish↔Range on ~half
//                  of all polls while spot trends one way — on the
//                  2026-08-12 trend day, "Range" readings were correct
//                  only 5% of the time at the 60-min horizon. A strategy1
//                  re-rank doesn't count either; it re-ranks constantly.
//   SQUARE_OFF     15:20 IST forced flat — intraday horizon only
//
// Sample data (positional, maxHold 30, buffer 2, persistence 3):
//   day 12, DTE 20, bias mismatch on 1 poll  → hold (miss 1/3)
//   day 12, DTE 20, mismatch 3 polls in a row → SIGNAL_CHANGE exit
//   day 30, any signal                        → TIME_STOP exit
//   DTE 2, any signal                         → EXPIRY_STOP exit
//
// Mutates pos._signalMiss/_lastMissTs (persisted in positions.json so a
// restart keeps the count). Returns { outcome, reason } or null to hold.
function checkExit(pos, netNow, result) {
  const horizon = getActiveHorizon();
  const move = netNow - pos.netEntry; // per-unit PnL
  // WIN/LOSS for discretionary exits is decided on the NET rupee outcome
  // (gross − estimated charges), not the gross move: the journal, the
  // tuner AND the losing-streak breaker in state.canOpen read Result, and
  // a "+₹62 gross / −₹50 net" trade calling itself WIN kept the breaker
  // from ever tripping while the account bled.
  const netWin = move * pos.lots * LOT_SIZE - (pos.estCharges ?? 0) >= 0;

  if (move <= -pos.stopDist) return { outcome: "LOSS", reason: "STOP" };
  // ride-mode positions have targetDist null — no fixed target, the
  // SIGNAL_CHANGE reversal below is their take-profit
  if (pos.targetDist != null && move >= pos.targetDist)
    return { outcome: netWin ? "WIN" : "LOSS", reason: "TARGET" };

  // PROFIT_LOCK (scalp's premium-band floor): once the move has traded
  // ABOVE lockDist, a pullback to/below it banks the win — a scalp that
  // reached +lock must never round-trip back to the stop. _lockArmed
  // lives on pos (persisted in positions.json), so a restart keeps it.
  if (pos.lockDist != null) {
    if (move > pos.lockDist) pos._lockArmed = true;
    else if (pos._lockArmed && move <= pos.lockDist)
      return { outcome: netWin ? "WIN" : "LOSS", reason: "PROFIT_LOCK" };
  }

  if (horizon.maxHoldDays) {
    // openedAtMs is epoch ms (new positions). Legacy positions only carry
    // openedAt — an IST wall-clock string, which parses as machine-local
    // time and must therefore be measured against nowIST(), not Date.now().
    const heldDays = pos.openedAtMs
      ? (Date.now() - pos.openedAtMs) / 86400000
      : (nowIST().getTime() - new Date(pos.openedAt).getTime()) / 86400000;
    if (heldDays >= horizon.maxHoldDays)
      return { outcome: netWin ? "WIN" : "LOSS", reason: "TIME_STOP" };
  }

  if (horizon.exitBufferDays && pos.expiry && daysUntil(pos.expiry) <= horizon.exitBufferDays)
    return { outcome: netWin ? "WIN" : "LOSS", reason: "EXPIRY_STOP" };

  // Only a true directional REVERSAL exits — Range drift and strategy
  // re-ranks are noise (see the header comment). Range-entered positions
  // (condor/straddle) exit when the market picks either direction.
  const mismatch =
    pos.entryBias === "Range"
      ? result.bias !== "Range"
      : (pos.entryBias === "Bullish" && result.bias === "Bearish") ||
        (pos.entryBias === "Bearish" && result.bias === "Bullish");
  if (mismatch) {
    // Count once per analysis (result.timestamp) — the 2s stream sweep
    // reuses the same poll result and must not inflate the count.
    if (pos._lastMissTs !== result.timestamp) {
      pos._signalMiss = (pos._signalMiss || 0) + 1;
      pos._lastMissTs = result.timestamp;
    }
    if (pos._signalMiss >= horizon.signalPersistence)
      return { outcome: netWin ? "WIN" : "LOSS", reason: "SIGNAL_CHANGE" };
  } else if (pos._signalMiss) {
    pos._signalMiss = 0; // signal realigned — reset the streak
  }

  if (horizon.squareOff && isSquareOffTime())
    return { outcome: netWin ? "WIN" : "LOSS", reason: "SQUARE_OFF" };
  return null;
}

// Net signed greek of a whole structure: Σ(buy greeks) − Σ(sell greeks).
// e.g. net theta of a debit spread = theta(long leg) − theta(short leg) —
// usually a small negative number, NOT the raw |theta| of one option.
// Returns null when any leg lacks greeks (flat feed) — gates then skip.
function getNetGreek(chain, legs, greek) {
  let net = 0;
  for (const leg of legs) {
    const row = chain.find(r => r.strike_price === leg.strike);
    const side = leg.type === "CE" ? row?.call_options : row?.put_options;
    const g = side?.option_greeks?.[greek];
    if (g == null) return null;
    net += leg.side === "BUY" ? g : -g;
  }
  return net;
}

// Estimated Upstox round-trip charges (₹) for a structure: each leg is one
// order on entry and one on exit. Flat brokerage dominates (₹20/order +
// GST ≈ ₹94 for a 2-leg round trip); statutory charges are percentages of
// premium turnover. Exit premiums are approximated by entry premiums —
// good enough, the % components are tiny. Returns null if a leg has no LTP.
// Sample: 2-leg spread, legs 38/17, 1 lot (qty 65)
//   brokerage 4×20 = 80 | GST ~14.6 | STT ~3.6 | NSE txn ~2.5 | rest <1
//   → ≈ ₹101 — vs the ₹51 average |gross PnL| of the first 11 live trades.
function estimateRoundTripCharges(chain, legs, lots) {
  const qty = Math.max(1, lots) * LOT_SIZE;
  let brokerage = 0, stt = 0, txn = 0, sebi = 0, ipft = 0, stamp = 0;
  for (const leg of legs) {
    const ltp = getLtp(chain, leg.strike, leg.type);
    if (ltp === null) return null; // strike missing — caller decides
    const turnover = ltp * qty;
    brokerage += 2 * COSTS.brokeragePerOrder; // entry order + exit order
    txn += 2 * turnover * COSTS.nseTxn;
    sebi += 2 * turnover * COSTS.sebiFee;
    ipft += 2 * turnover * COSTS.ipft;
    stt += turnover * COSTS.sttSell;    // every leg is sold once per round trip
    stamp += turnover * COSTS.stampBuy; // ...and bought once
  }
  const gst = COSTS.gstRate * (brokerage + txn + sebi + ipft);
  return Number((brokerage + stt + txn + sebi + ipft + stamp + gst).toFixed(2));
}

// Lot count from risk (MAX_RISK / risk-per-lot), then capped by what the
// capital can carry (debit cost for long structures, approximate margin
// for credit structures) and by the MAX_LOTS hard cap.
function getLots(netEntry, stopDist) {
  const riskPerLot = stopDist * LOT_SIZE;
  if (riskPerLot <= 0) return 0;

  let lots = Math.floor(MAX_RISK / riskPerLot);

  const costPerLot = netEntry < 0 ? MARGIN_PER_CREDIT_LOT : netEntry * LOT_SIZE;
  if (costPerLot > 0) lots = Math.min(lots, Math.floor(CAPITAL / costPerLot));

  return Math.max(0, Math.min(lots, MAX_LOTS));
}

module.exports = {
  getLtp,
  getNetPremium,
  exitLevels,
  checkExit,
  getLots,
  getNetGreek,
  estimateRoundTripCharges
};

//pricing.js
