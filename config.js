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
  instrumentKey: "NSE_EQ|INE062A01020",
  instrumentName: "SBIN",  // "Index or Stock" line of the Telegram alerts
  expiryDate: "2026-08-25", // auto-resolved at startup from the instruments
                            // master (nearest expiry for the underlying);
                            // EXPIRY_DATE env or the live-mode prompt pins it
  futuresKey: "",           // near-month FUTURES of the underlying — the
                            // futures-buildup confirmation gate. Auto-resolved
                            // at startup; FUTURES_KEY env pins it. Empty =
                            // gate inactive.
  strikeRange: 100,         // analyze ATM ± this many points
  strikeDiff: 10,           // spread width: sell leg = ATM ± strikeDiff (asked at startup)
  pollMs: 180000,           // poll every 3 min — Upstox refreshes OI on that cadence,                 // so faster polls just re-read stale OI against price noise
  portfolioRefreshMs: 15 * 60000, // snapshot long-term holdings every 15 min
  positionsRefreshMs: 5 * 60000,  // snapshot broker F&O positions every 5 min
  candleRefreshMs: 5 * 60000,     // refresh the 5-minute candle trend every 5 min
  fastExitMs: 45000,              // between-poll exit check (0 = off) — price-only,
                                  // one quote call, and only while a position is open
  wsUrl: process.env.UPSTOX_WS_URL || "" // WebSocket stream URL (optional)
};

const CAPITAL = 50000;      // trading capital in ₹
const LOT_SIZE = 750;        // contract quantity per lot
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
// Below the ratio = limited OI support → scalp: bank a quick premium-
// relative band (target SCALP_TARGET_PCT of net entry, stop = target /
// RISK_REWARD keeps 1:2, and once the move has SEEN +SCALP_LOCK_PCT a
// pullback to that level banks the win instead of round-tripping back).
// Range-bias structures (condor/straddle) keep the %-of-premium rule.
//
// PREMIUM-RELATIVE, not absolute points (2026-08-20): the old 10-pt
// target / 5-pt stop were NIFTY premium scale. On SBIN an ATM structure
// costs ~₹4–13, so the 10-pt target meant "the option must double+" —
// unreachable, which also let the cost-floor gate pass on a reward that
// never existed. 20%/10% of net entry scales to ANY stock.
const OI_STRONG_RATIO = 2.5;
// 2026-09-05 retune (same rules as the NIFTY bot): scalp target 30% of
// |net entry| (stop = target / RISK_REWARD = 15%), and a three-rung profit-
// lock LADDER — the highest rung the move has traded ABOVE is armed and a
// pullback to it exits PROFIT_LOCK. Keep SCALP_LOCK_PCTS sorted ascending.
const SCALP_TARGET_PCT = 0.3;  // scalp target = 30% of |net entry| (was 0.2)
// 2026-09-11: the scalp/naked STOP is its own % of entry, no longer
// target / RISK_REWARD (15%). With the lock ladder banking at 8/10/12.5%
// a 15% stop needed > 62% wins to break even (realised: SENSEX 3/8, NIFTY
// 1/10). Replaying 24 Aug – 10 Sep: 10% vs 15% = +₹113 on the same trades.
// Target stays 30%, so the journal RR reads 3:1.
const SCALP_STOP_PCT = 0.10;
const SCALP_LOCK_PCTS = [0.08, 0.10, 0.125];
const SCALP_LOCK_PCT = SCALP_LOCK_PCTS[0]; // first rung — kept for older callers

// Naked long options (Buy Call / Buy Put). History: 0 wins in 8 trades,
// −₹5,133 across both journals under the OLD gates. Re-enabled 2026-08-20
// (user call) now that entries also require VWAP-side alignment, a volume
// surge, futures-buildup agreement and a depth check on top of the
// score-100 trigger — flip to true to block them structurally again.
// Config-level (not tuning.json) because the tuner recomputes its
// blocklist from post-regime data and would silently forget the block.
const BLOCK_NAKED_LEGS = false; // 2026-09-05: opened for the naked-only test week

// NAKED-ONLY TEST WEEK (2026-09-05 → ~2026-09-12, same as the NIFTY bot):
// when true, the ONLY tradeable structure is the single naked leg on the
// bias side (Buy Call for Bullish, Buy Put for Bearish; Range = no trade).
// Spread/condor/straddle code stays untouched — flip this back to false
// (and BLOCK_NAKED_LEGS to true) to return to the previous behaviour. The
// naked leg must still score NAKED_MIN_SCORE (100 = 2.5× OI dominance +
// build-up breadth + CONFIRMED candle trend); weaker reads are journaled
// as blocked signals. Naked legs are exempt from the tuner's
// blockedStrategies while the test runs.
const NAKED_ONLY = true;
const NAKED_MIN_SCORE = 100;
// Confidence floor for the naked leg (2026-09-11) — used INSTEAD of the
// tuner's RULES.minConfidence override while NAKED_ONLY runs. THIS bot's
// tuner had raised minConfidence to 90 from 13 spread-era trades, which
// turned every conf-83 naked read (41 Buy Call setups on 9–10 Sep) into a
// silent NO TRADE (no Blocked reason). Same value as RULES.minConfidence.
const NAKED_MIN_CONFIDENCE = 70;

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
// 2026-08-21: stock-options retune (premium-relative scalps, naked block,
// persistence 3, day-open gate) — the Aug 18–20 SBIN trades measured the
// NIFTY-calibrated policy and are not evidence for this one.
// 2026-09-11: moved to the naked-only start — spread trades are not
// evidence for the naked policy (they set this bot's minConfidence to 90).
const TUNING_REGIME_START = "2026-09-05";

const RULES = {
  minConfidence: 70,          // trade filter: below this → NO TRADE
  // Entry window (2026-09-11), IST. No NEW entries before 10:00 — the first
  // volume-surge reading (09:45) compares the opening candle against five
  // others and always looks like a surge (10 Sep SENSEX 09:45: −₹1,317) —
  // and none after 14:50 (< 30 min to the square-off; 9 Sep NIFTY 15:06:
  // charges only). Replay showed SENSEX's 14:35/14:52 entries were its
  // best, so the cap is 14:50, not 14:30. Exits are never gated by this.
  entryStartHour: 10, entryStartMin: 0,
  entryEndHour: 14, entryEndMin: 50,
  // Scalp time stop (2026-09-11): a scalp/naked position that has armed NO
  // profit-lock rung within this many minutes exits TIME_STOP — Range drift
  // is not a SIGNAL_CHANGE and intraday has no maxHoldDays, so the 10 Sep
  // SENSEX put sat 147 min for a −15% stop. 0 = off.
  scalpTimeStopMin: 45,
  // Day-extreme retest gate (2026-09-11): skip a Bearish entry when spot is
  // ABOVE a day low set ≥ extremeRetestAgeMin ago by less than
  // extremeRetestPct (put bought at support — 9 Sep NIFTY 12:04, 9 pts
  // above the low: −₹1,143), and a Bullish entry symmetrically under an old
  // day high (25 Aug SENSEX 11:59: −₹679). A fresh break passes. In replay
  // this was the single biggest lever (OFF −₹1,475 → ON +₹356 over 14
  // days) but on 2–4 events — 0.10% is the middle of the range that held.
  // 0 = off.
  extremeRetestPct: 0.001,
  extremeRetestAgeMin: 30,
  // Entry-side persistence: the CURRENT bias must have held for this many
  // consecutive polls (including this one) before any entry is allowed.
  // 3 polls = ~9 min of agreement at the 3-min cadence. On the SBIN
  // sheets (Aug 18–20) the bias flipped on 59% of polls; persistence-3
  // Bearish signals hit 66–69% at the ~60-min horizon vs ~50% unfiltered.
  entryBiasPersistence: 3,
  maxOpenPositions: 1,
  maxDailyLoss: MAX_RISK,     // one full-risk loss ends the day
  maxConsecutiveLosses: 3,    // 3 losses in a row → done for the day
  // Friction cap: flat brokerage dominates stock-option round trips
  // (~₹105–125 per 2-leg lap). 3 trades ≈ ₹360/day worst case — beyond
  // that the day is fighting its own charges.
  maxTradesPerDay: 3,
  squareOffHour: 15,          // 15:20 IST forced exit
  squareOffMin: 20,
  // Day-anchor alignment: directional entries must be on the day-drift
  // side of the anchor — Bearish only below it, Bullish only above. The
  // anchor is today's VWAP when candle data is available (the proper
  // intraday value anchor), falling back to the session's first spot
  // reading. On the NIFTY sheets this flipped persisted-Bearish hit rates
  // from 27% to 67% at the 60-min horizon. Range structures are exempt.
  dayOpenAlignment: true,
  // Volume-surge confirmation: directional entries need the latest 5-min
  // candle volume ≥ this multiple of the day's average — the recorded
  // failed signals were low-volume drifts that mean-reverted. 0 = off;
  // the check drops out while candle history is too short (< 6 candles).
  volumeSurgeMin: 1.2,
  // Depth cost ceiling: at entry time the summed half-spread of the legs
  // ((ask − bid) / 2 each, i.e. the slippage of crossing to mid) must be
  // ≤ this fraction of the reference target, or the fill cost eats the
  // edge before the market moves. 0 = off; skipped when depth is missing.
  maxSpreadCostFrac: 0.25,
  // Churn guard: after any exit, no new entry for this long. The recorded
  // history shows exit→re-entry gaps of 1–3 minutes into the SAME legs,
  // each round trip costing ~₹100 in charges for a sub-1-point move.
  // 30 min (was 15): the SBIN edge only shows at ~60-min holds — there is
  // nothing to re-enter for minutes after an exit.
  reentryCooldownMs: 30 * 60000
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
  if (process.env.FUTURES_KEY) CONFIG.futuresKey = process.env.FUTURES_KEY;
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
  SCALP_TARGET_PCT,
  SCALP_STOP_PCT,
  SCALP_LOCK_PCT,
  SCALP_LOCK_PCTS,
  BLOCK_NAKED_LEGS,
  NAKED_ONLY,
  NAKED_MIN_SCORE,
  NAKED_MIN_CONFIDENCE,
  COSTS,
  MIN_EDGE_MULTIPLE,
  TUNING_REGIME_START,
  RULES,
  MARGIN_PER_CREDIT_LOT,
  TG,
  applyEnvConfig
};


//config.js
