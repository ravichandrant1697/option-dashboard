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
  instrumentName: "NIFTY",  // "Index or Stock" line of the Telegram alerts
  expiryDate: "2026-09-01", // auto-resolved at startup from the instruments
                            // master (nearest WEEKLY expiry for NIFTY, rolls
                            // on expiry day); EXPIRY_DATE env or the live-mode
                            // prompt pins it
  futuresKey: "",           // near-month NIFTY FUTURES — feeds the futures-
                            // buildup confirmation gate AND, because an index
                            // trades no volume, the VWAP/volume-surge gates
                            // (signals.js falls back to futures candles).
                            // Auto-resolved at startup; FUTURES_KEY env pins
                            // it. Empty = those gates inactive.
  strikeRange: 1000,        // analyze ATM ± this many points
  strikeDiff: 50,           // spread width: sell leg = ATM ± strikeDiff (asked at startup)
  pollMs: 180000,           // poll every 3 min — Upstox refreshes OI on that cadence,                 // so faster polls just re-read stale OI against price noise
  portfolioRefreshMs: 15 * 60000, // snapshot long-term holdings every 15 min
  positionsRefreshMs: 5 * 60000,  // snapshot broker F&O positions every 5 min
  candleRefreshMs: 5 * 60000,     // refresh the 5-minute candle trend every 5 min
  fastExitMs: 5000,               // between-poll exit check (0 = off) — price-only,
                                  // one quote call, and only while a position is open.
                                  // 2026-10-06: 45 s → 5 s — live stops filled at −12.1 %
                                  // avg vs the −10 % rule and locks below the rung (≈ ₹100
                                  // slippage per trade); 12 quote calls/min per open position
  wsUrl: process.env.UPSTOX_WS_URL || "" // WebSocket stream URL (optional)
};

const CAPITAL = 50000;      // trading capital in ₹
const LOT_SIZE = 65;        // NIFTY contract quantity per lot
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
// 2026-09-05 retune for the naked-leg test week. Replaying the recorded
// 3-min spot paths (14 Aug – 4 Sep, ATM ≈ ₹80 premium, delta 0.5) with a
// persistence-3 entry, 30-min cooldown and 3 trades/day: the old 20/10/10
// band netted ≈ +₹1.5k over 29 trades (9 stops, 5 targets, 11 locks);
// 30/15/12.5 netted ≈ +₹9.9k over 31 (6 stops, 6 targets, 14 locks). The
// 10% stop (≈ 8 pts ≈ 16 NIFTY pts) sat exactly at the p95 of a single
// 3-min spot move, so noise stopped trades out. Stop stays = target /
// RISK_REWARD (1:2), so 30% target ⇒ 15% stop. Spot-proxy replay — no
// theta/IV/slippage — treat as direction, not precision.
const SCALP_TARGET_PCT = 0.3;  // scalp target = 30% of |net entry| (was 0.2)
// 2026-09-11: the scalp/naked STOP is its own % of entry, no longer
// target / RISK_REWARD (15%). With the lock ladder banking at 8/10/12.5%
// a 15% stop needed > 62% wins to break even (realised: SENSEX 3/8, NIFTY
// 1/10). Replaying 24 Aug – 10 Sep: 10% vs 15% = +₹113 on the same trades.
// Target stays 30%, so the journal RR reads 3:1.
const SCALP_STOP_PCT = 0.10;
// Profit-lock LADDER (2026-09-05, user directive): three floors as % of
// |net entry|, ascending. The highest floor the move has traded ABOVE is
// armed; a pullback to/below the armed floor exits PROFIT_LOCK. So a move
// that saw +11% and turns exits at +10%, not at the +12.5% it never reached
// and not back at the stop. Keep the array sorted ascending.
const SCALP_LOCK_PCTS = [0.08, 0.10, 0.125];
// 2026-10-06: an ABSOLUTE first rung in premium points, merged into the %
// ladder (pricing.exitLevels sorts + dedupes). With the 5-s fast exit a
// 10-pt rise on a ~₹130 NIFTY weekly premium (≈ 6–9 %) arms a floor at
// +10 — ₹650 gross on the lot — so a move that stalls short of the 8 %
// rung still banks instead of round-tripping to the stop. 0 = off.
const SCALP_LOCK_POINTS = 10;
const SCALP_LOCK_PCT = SCALP_LOCK_PCTS[0]; // first % rung — kept for older callers

// Naked long options (Buy Call / Buy Put). History: 0 wins in 8 trades,
// −₹5,133 across both journals under the OLD gates. Re-enabled 2026-08-20
// (user call) now that entries also require VWAP-side alignment, a volume
// surge, futures-buildup agreement and a depth check on top of the
// score-100 trigger — flip to true to block them structurally again.
// Config-level (not tuning.json) because the tuner recomputes its
// blocklist from post-regime data and would silently forget the block.
const BLOCK_NAKED_LEGS = false; // 2026-09-05: opened for the naked-only test week

// NAKED-ONLY TEST WEEK (2026-09-05 → ~2026-09-12): when true, the ONLY
// tradeable structure is the single naked leg on the bias side (Buy Call
// for Bullish, Buy Put for Bearish; Range = no trade). The spread/condor/
// straddle code stays in the project untouched — flip this back to false
// (and BLOCK_NAKED_LEGS to true) to return to the previous behaviour.
// The naked leg must still score NAKED_MIN_SCORE in the strategy ranking
// (100 = 2.5× OI dominance + build-up breadth + CONFIRMED 5-min candle
// trend); a weaker read is journaled as a blocked signal, not traded.
// Naked legs are also exempt from the tuner's blockedStrategies while the
// test runs — five losing trades would otherwise switch the test off
// mid-week; judge the week from the Trades sheet instead.
const NAKED_ONLY = true;
const NAKED_MIN_SCORE = 100;
// Confidence floor for the naked leg (2026-09-11) — used INSTEAD of the
// tuner's RULES.minConfidence override while NAKED_ONLY runs. The SBIN
// tuner had raised minConfidence to 90 from 13 spread-era trades, which
// turned every conf-83 naked read into a silent NO TRADE (no Blocked
// reason in the sheet). Same value as RULES.minConfidence's default.
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
// evidence for the naked policy (they set SBIN's minConfidence to 90).
const TUNING_REGIME_START = "2026-09-05";

const RULES = {
  minConfidence: 70,          // trade filter: below this → NO TRADE
  // Entry window, IST (2026-09-11: 10:00–14:50; 2026-10-06, user: widened to
  // 09:30–15:10 — the fresh-break gate below now carries the chop filtering
  // the clock used to do). Replay 09-11→10-06 under that gate: 09:30–15:10
  // +₹13.1k / 30 trades vs 10:00–14:50 +₹13.2k / 26 — the extra half-hours
  // added four trades for −₹82 net; a 15:0x entry has ~10 min before the
  // 15:20 square-off. Exits are never gated by this.
  entryStartHour: 9, entryStartMin: 30,
  entryEndHour: 15, entryEndMin: 10,
  // Fresh-break entry gate (2026-10-06): a directional entry only AT or
  // THROUGH the day extreme in its direction (spot ≤ the previous polls' day
  // low for a put, ≥ the day high for a call), not on the 4th+ consecutive
  // new-extreme poll (freshBreakMaxRun) and not after a last-poll jump of
  // ≥ freshBreakMaxMovePct in the trade direction — both are chases that
  // stop out (09-22 10:42/10:46, 10-01 12:57/13:00). Live since 09-11:
  // fresh-break entries +₹4,931 (26 trades, 58 %), inside-range entries
  // −₹10,062 (23 trades, 35 %). Replay: as-ran −₹2,180 → +₹13.1k, stops
  // 16 → 7. Range bias is exempt (never trades naked anyway). false = off.
  freshBreakOnly: true,
  freshBreakMaxRun: 3,
  freshBreakMaxMovePct: 0.0015,
  // Minimum break depth (2026-10-07): the fresh break must clear the prior
  // day extreme by this fraction of spot (0.0003 = 0.03 % ≈ SBIN 0.3 /
  // NIFTY 7 / SENSEX 22 pts). Replay 09-11→10-07 (analysis-scripts/
  // minbreak.js): all 7 stops under the live rule were breaks < 0.03 %
  // (16 trades −₹3,970); breaks ≥ 0.03 % were 10/10 wins +₹11.9k; sequential
  // net +₹7.9k/26 → +₹10.4k/12, 83 % win. 10-07 losses: SENSEX 10 pts
  // (0.013 %), SBIN 0.15 pts (0.016 %) — both one-tick wicks. 0 = off.
  freshBreakMinPct: 0.0003,
  // Tick entries (2026-10-07, user: "no wait"): between the 3-min chain
  // polls, every streamed spot tick re-runs the trade plan (same gates,
  // same bias/chain as the last poll, spot = the tick) and opens the
  // position the moment a fresh break passes — instead of buying the
  // aftermath at the next poll (10-07 13:12 @144 after a 166 print at
  // 13:09–13:12). Needs the WebSocket; polling-only sessions are unchanged.
  // tickEntryMinGapMs throttles the re-plan; false = poll entries only.
  tickEntry: true,
  tickEntryMinGapMs: 2000,
  // Tick journal (2026-10-07, user: backtest the tick-by-tick process):
  // every streamed tick → ticks-<date>-<HHMM>.csv, every decision →
  // events-<date>-<HHMM>.csv (ticklog.js); both go to Telegram at the end
  // of each run. tickJournalStrikes = how many strikes either side of ATM
  // (CE + PE) are streamed purely for the journal, so a replay has option
  // prices for the strikes the bot could have chosen, not only the ones it
  // did. 2 → ATM ± 2 = 10 option keys + index + futures + plan/position legs.
  tickJournal: true,
  tickJournalStrikes: 2,
  // Stream-fed analysis (2026-10-07, user: chain / candles / futures via the
  // WebSocket): the analysis window (ATM ± strikeRange, CE + PE) plus index
  // and futures are streamed; every tick updates a live copy of the last
  // REST chain (ltp, oi, iv, greeks, volume), 5-min candles are built from
  // index/futures ticks (volume = vtt deltas), and the futures build-up
  // reads the futures tick. The 3-min cycle then analyses the LIVE chain
  // (no REST) whenever the index tick is fresh, and between cycles the
  // bias is re-computed every streamAnalysisMs so tick entries see it the
  // moment the exchange publishes new OI. REST stays as the seed (one chain
  // call at startup and every streamReseedMs for prev_oi / close_price /
  // new strikes) and as the fallback whenever ticks go stale. The Dashboard
  // row and the day-extreme bookkeeping stay on the 3-min grid. false or
  // STREAM_ANALYSIS=0 = the REST path exactly as before.
  streamAnalysis: true,
  streamAnalysisMs: 5000,
  streamReseedMs: 30 * 60000,
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
  // this was the single biggest lever (OFF −₹1,475 → ON +₹356 at 0.05–0.10%,
  // +₹1,276 at 0.15–0.25%) but on 2–4 events. 2026-09-15: 0.10 → 0.15% —
  // the 11 Sep SBIN 13:47/13:56 puts were bought 0.11–0.13% above the day
  // low (the gate had just blocked the same setup at 0.02–0.09%) and lost
  // ₹1.1–1.5k each; 0.15% blocks them and sits inside the replay plateau.
  // 0 = off.
  extremeRetestPct: 0.0015,
  extremeRetestAgeMin: 30,
  // Entry-side persistence: the CURRENT bias must have held for this many
  // consecutive polls (including this one) before any entry is allowed.
  // Built for the Aug chop (bias flipped on 59% of polls); since the 09-08
  // build-up fix it flips on 4–5% of polls, so 3 polls bought nothing but a
  // 9-minute lag — entries landed at the END of the move (10-05 13:48: all
  // three bots bought six minutes after the 13:42 spike). 2026-10-06 (user):
  // 3 → 1 = gate off; the fresh-break gate carries the chop filtering.
  // Replay under that gate: persistence 3 +₹13.1k/30 trades, 2 +₹13.7k/33,
  // 1 +₹14.4k/35 (adds 3 first-poll winners and 3 stops, drops 1 stop).
  entryBiasPersistence: 1,
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
  SCALP_LOCK_POINTS,
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
