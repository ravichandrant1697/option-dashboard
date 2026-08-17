/**
 * CONFIG — every constant and tunable of the option dashboard.
 *
 * All other modules read configuration from here; nothing outside this
 * file touches process.env for configuration (the DEBUG_* trace flags,
 * read at call time, are the only exception).
 */
require("dotenv").config();

const ACCESS_TOKEN = process.env.UPSTOX_TOKEN || "YOUR_ACCESS_TOKEN";
const HOST = "https://api.upstox.com/"; // main API host
const ORDER_HOST = "https://api-hft.upstox.com/"; // V3 order APIs live on the HFT host
const FILE_NAME = "option_dashboard.xlsx";   // Excel workbook (Dashboard + Trades sheets)
const POSITIONS_FILE = "positions.json";     // open-position state, survives restarts
const TUNING_FILE = "tuning.json";           // self-tuned parameters, written daily

// Runtime config — instrumentKey and strikeDiff are set by the startup
// prompts (NIFTY or Stock, and the gap between strikes for spreads).
const CONFIG = {
  instrumentKey: "NSE_INDEX|Nifty 50",
  expiryDate: "2026-08-18", // nearest expiry — update weekly (auto-pick is a V6 item)
  strikeRange: 1000,         // analyze ATM ± this many points
  strikeDiff: 50,           // spread width: sell leg = ATM ± strikeDiff (asked at startup)
  pollMs: 180000,           // poll every 3 min — Upstox refreshes OI on that cadence,
                            // so faster polls just re-read stale OI against price noise
  portfolioRefreshMs: 15 * 60000, // snapshot long-term holdings every 15 min
  positionsRefreshMs: 5 * 60000,  // snapshot broker F&O positions every 5 min
  candleRefreshMs: 5 * 60000,     // refresh the 5-minute candle trend every 5 min
  wsUrl: process.env.UPSTOX_WS_URL || "" // WebSocket stream URL (optional)
};

const CAPITAL = 50000;      // trading capital in ₹
const LOT_SIZE = 65;        // contract quantity per lot
const MAX_LOTS = 1;         // hard cap per trade — risk sizing never exceeds this

// Risk model: risk up to 10% of capital per trade. (2% = ₹1,000 can never
// cover one lot's stop distance, so nothing would ever trade.)
const RISK_PER_TRADE = 0.1;
const MAX_RISK = CAPITAL * RISK_PER_TRADE; // ₹5,000

// 1:2 risk-reward everywhere: stop = 50% of net premium,
// target distance = 2 × stop distance.
const STOP_PCT = 0.5;
const RISK_REWARD = 2;

// Conviction-based exit style for DIRECTIONAL entries (bias Bullish or
// Bearish). Dominant-side OI ≥ OI_STRONG_RATIO × the other side = strong
// conviction → NO fixed target: the position rides until the signal
// reverses (SIGNAL_CHANGE is the take-profit; the stop still protects).
// Below the ratio = limited OI support → scalp: take profit at the 5–10 pt
// band (target SCALP_TARGET_POINTS, stop = target / RISK_REWARD keeps 1:2,
// and once the move has SEEN +SCALP_LOCK_POINTS a pullback to that level
// banks the win instead of round-tripping back to the stop).
// Range-bias structures (condor/straddle) keep the %-of-premium rule.
// NAKED legs (Buy Call / Buy Put) always scalp, never ride: their edge is
// the quick 5–10 pt band, and an unhedged ATM option left riding through
// a chop day donates the whole band back plus theta.
const OI_STRONG_RATIO = 2.5;
const SCALP_TARGET_POINTS = 10;
const SCALP_LOCK_POINTS = 5;

// Upstox NSE-options charge model (per executed ORDER — each leg is one
// order, entry and exit are separate orders). Rates as of Oct 2024 revision.
// Journal PnL is NET of these, so the tuner/backtest learn from real money.
// At 1 lot the fixed brokerage+GST alone is ≈ ₹94 per 2-leg round trip
// (≈ 1.45 premium points at qty 65) — the dominant cost by far.
const COSTS = {
  brokeragePerOrder: 20,  // flat per executed order
  sttSell: 0.001,         // 0.1% of premium turnover, SELL orders only
  nseTxn: 0.0003503,      // 0.03503% of premium turnover, both sides
  sebiFee: 0.000001,      // ₹10/crore, both sides
  ipft: 0.000005,         // ₹50/crore, both sides
  stampBuy: 0.00003,      // 0.003% of premium turnover, BUY orders only
  gstRate: 0.18           // on brokerage + NSE txn + SEBI + IPFT
};

// Entry cost floor: the plan's reward (target × qty) must be at least this
// many times the estimated round-trip charges, or the trade isn't worth
// the friction. 3× ⇒ a full target win nets ≥ 2/3 of its gross.
const MIN_EDGE_MULTIPLE = 3;

// Tuning learns ONLY from trades on/after this date. The 25 trades before
// it were produced by the old exit policy (persistence-1 churn, 1–12 min
// holds, gross PnL) — they measure a policy that no longer exists, and
// feeding them to the tuner would block the strategies the new rules are
// meant to rehabilitate. Move this forward if the policy changes again.
const TUNING_REGIME_START = "2026-08-14";

const RULES = {
  minConfidence: 70,          // trade filter: below this → NO TRADE
  // Entry-side persistence: the CURRENT bias must have held for this many
  // consecutive polls (including this one) before any entry is allowed.
  // Exits had persistence from 2026-08-13 but entries fired on a single
  // poll's bias — on 2026-08-14 (chop, bias flipped ~60×/117 polls) that
  // asymmetry entered trades on 1- and 2-poll bias blips inside opposite
  // stretches. 2 polls = ~6 min of agreement at the 3-min cadence.
  entryBiasPersistence: 2,
  maxOpenPositions: 1,
  maxDailyLoss: MAX_RISK,     // one full-risk loss ends the day
  maxConsecutiveLosses: 3,    // 3 losses in a row → done for the day
  squareOffHour: 15,          // 15:20 IST forced exit
  squareOffMin: 20,
  // Churn guard: after any exit, no new entry for this long. The recorded
  // history shows exit→re-entry gaps of 1–3 minutes into the SAME legs,
  // each round trip costing ~₹100 in charges for a sub-1-point move.
  reentryCooldownMs: 15 * 60000
};

// Approximate SPAN + exposure margin for one hedged credit lot (Iron
// Condor). Premium-vs-capital is NOT a valid affordability check for short
// legs — replace with your broker's margin API for real numbers.
const MARGIN_PER_CREDIT_LOT = 45000;

const TG = { token: process.env.TG_BOT_TOKEN, chatId: process.env.TG_CHAT_ID };

// Non-interactive config via env vars — used by tick mode (CI/GitHub
// Actions) where the startup prompts can't run.
function applyEnvConfig() {
  if (process.env.INSTRUMENT_KEY) CONFIG.instrumentKey = process.env.INSTRUMENT_KEY;
  if (/^\d{4}-\d{2}-\d{2}$/.test(process.env.EXPIRY_DATE || "")) {
    CONFIG.expiryDate = process.env.EXPIRY_DATE;
  }
  const diff = Number(process.env.STRIKE_DIFF);
  if (Number.isFinite(diff) && diff > 0) CONFIG.strikeDiff = diff;
}

module.exports = {
  ACCESS_TOKEN,
  HOST,
  ORDER_HOST,
  FILE_NAME,
  POSITIONS_FILE,
  TUNING_FILE,
  CONFIG,
  CAPITAL,
  LOT_SIZE,
  MAX_LOTS,
  RISK_PER_TRADE,
  MAX_RISK,
  STOP_PCT,
  RISK_REWARD,
  OI_STRONG_RATIO,
  SCALP_TARGET_POINTS,
  SCALP_LOCK_POINTS,
  COSTS,
  MIN_EDGE_MULTIPLE,
  TUNING_REGIME_START,
  RULES,
  MARGIN_PER_CREDIT_LOT,
  TG,
  applyEnvConfig
};


//config.js
