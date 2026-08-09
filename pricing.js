/**
 * PRICING — structure pricing, exit levels/decisions, and position sizing.
 * Everything here works on the NET premium of a whole structure
 * (Σ buy LTPs − Σ sell LTPs), never on individual legs.
 */
const {
  STOP_PCT,
  RISK_REWARD,
  MAX_RISK,
  LOT_SIZE,
  CAPITAL,
  MARGIN_PER_CREDIT_LOT
} = require("./config");
const { isSquareOffTime, daysUntil } = require("./clock");
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

// 1:2 risk-reward for every strategy: stop = STOP_PCT (50%) of the net
// premium, target = RISK_REWARD (2) × stop distance. For credit structures
// the 2× target equals full premium decay (hold toward expiry).
function exitLevels(netEntry) {
  const stopDist = Math.abs(netEntry) * STOP_PCT;
  return { stopDist, targetDist: stopDist * RISK_REWARD };
}

// Exit decision for an open position, horizon-aware. Priority order:
//   STOP → TARGET → TIME_STOP → EXPIRY_STOP → SIGNAL_CHANGE → SQUARE_OFF.
//
//   TIME_STOP      position held past the horizon's maxHoldDays
//                  (positional 30d, swing 90d — the playbook's limits)
//   EXPIRY_STOP    expiry within exitBufferDays — get out BEFORE the
//                  gamma/theta cliff (playbook: greeks stop mattering
//                  on expiry day)
//   SIGNAL_CHANGE  bias flipped or a new top strategy — but only after
//                  signalPersistence CONSECUTIVE mismatching polls, so a
//                  multi-day position isn't churned out by one noisy tick
//                  (intraday keeps persistence 1 = original behavior)
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

  if (move <= -pos.stopDist) return { outcome: "LOSS", reason: "STOP" };
  if (move >= pos.targetDist) return { outcome: "WIN", reason: "TARGET" };

  if (horizon.maxHoldDays) {
    const heldDays = (Date.now() - new Date(pos.openedAt).getTime()) / 86400000;
    if (heldDays >= horizon.maxHoldDays)
      return { outcome: move >= 0 ? "WIN" : "LOSS", reason: "TIME_STOP" };
  }

  if (horizon.exitBufferDays && pos.expiry && daysUntil(pos.expiry) <= horizon.exitBufferDays)
    return { outcome: move >= 0 ? "WIN" : "LOSS", reason: "EXPIRY_STOP" };

  const mismatch = result.strategy1 !== pos.strategy || result.bias !== pos.entryBias;
  if (mismatch) {
    // Count once per analysis (result.timestamp) — the 2s stream sweep
    // reuses the same poll result and must not inflate the count.
    if (pos._lastMissTs !== result.timestamp) {
      pos._signalMiss = (pos._signalMiss || 0) + 1;
      pos._lastMissTs = result.timestamp;
      console.log(
        `   ⚠️ signal mismatch ${pos._signalMiss}/${horizon.signalPersistence} ` +
          `for ${pos.strategy} (bias ${pos.entryBias} → ${result.bias}, top ${result.strategy1})`
      );
    }
    if (pos._signalMiss >= horizon.signalPersistence)
      return { outcome: move >= 0 ? "WIN" : "LOSS", reason: "SIGNAL_CHANGE" };
  } else if (pos._signalMiss) {
    pos._signalMiss = 0; // signal realigned — reset the streak
  }

  if (horizon.squareOff && isSquareOffTime())
    return { outcome: move >= 0 ? "WIN" : "LOSS", reason: "SQUARE_OFF" };
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

// Lot count from risk (MAX_RISK / risk-per-lot), then capped by what the
// capital can carry: debit cost for long structures, approximate margin
// for credit structures.
function getLots(netEntry, stopDist) {
  const riskPerLot = stopDist * LOT_SIZE;
  if (riskPerLot <= 0) return 0;

  let lots = Math.floor(MAX_RISK / riskPerLot);

  const costPerLot = netEntry < 0 ? MARGIN_PER_CREDIT_LOT : netEntry * LOT_SIZE;
  if (costPerLot > 0) lots = Math.min(lots, Math.floor(CAPITAL / costPerLot));

  return Math.max(0, lots);
}

module.exports = { getLtp, getNetPremium, exitLevels, checkExit, getLots, getNetGreek };
