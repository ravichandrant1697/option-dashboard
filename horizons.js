/**
 * HORIZONS — trading-horizon profiles: intraday, positional, swing.
 *
 * Playbook mapping ("Types of Traders" + tool rules):
 *   Day trader        → intraday:   nothing held overnight, 5-min tools,
 *                                    15:20 square-off, product I
 *   Positional trader → positional: held days → 1 MONTH, daily timeframe,
 *                                    20/50 daily SMA trend, product D
 *   Swing trader      → swing:      held up to 3 MONTHS, daily timeframe,
 *                                    100/200 daily SMA trend (the playbook's
 *                                    investment MA rule), product D
 *
 * Profile fields:
 *   product            broker product: "I" intraday / "D" carry-forward
 *   pollMs             chain poll interval (overrides CONFIG.pollMs)
 *   trend              {source:"intraday"} = last six 5-min candles;
 *                      {source:"daily-ma", fast, slow} = SMA crossover on
 *                      daily candles (fast above slow = Up — playbook MA rule)
 *   trendRefreshMs     how often to recompute the trend
 *   squareOff          true → forced 15:20 IST exit + no entries after
 *   maxHoldDays        TIME_STOP: exit any position held this long (null = off)
 *   minEntryDTE        block entries when expiry is nearer than this many
 *                      days — a weekly expiry cannot host a one-month view
 *   exitBufferDays     EXPIRY_STOP: exit when expiry is this close, BEFORE
 *                      the gamma/theta cliff ("on the day of expiry, all
 *                      of the greeks aren't important" — playbook)
 *   signalPersistence  SIGNAL_CHANGE only after this many CONSECUTIVE
 *                      mismatching polls — multi-day positions must not be
 *                      churned out by one noisy 5-minute tick
 *   plannedHoldDays    horizon for the theta gate: projected decay over
 *                      this many days must not eat >50% of the target move
 *
 * Sample data — same Bull Call Spread plan under each horizon:
 *   intraday:   expiry 4d away OK (minEntryDTE 0), exits by 15:20 today
 *   positional: expiry 4d away  → ⛔ blocked (needs ≥10 DTE — pick monthly);
 *               expiry 32d away → enters product D, TIME_STOP at 30d,
 *               EXPIRY_STOP when DTE ≤ 2, bias flip must persist 3 polls
 *   swing:      expiry 32d away → ⛔ blocked (needs ≥30... use a far
 *               monthly, e.g. 81d) → TIME_STOP 90d, EXPIRY_STOP DTE ≤ 5
 */
const { CONFIG } = require("./config");

const HORIZONS = {
  intraday: {
    name: "intraday",
    product: "I",
    pollMs: 60000,                 // 60s — exits are minutes away
    trend: { source: "intraday" }, // last six 5-min candles (~30 min)
    trendRefreshMs: 5 * 60000,
    squareOff: true,
    maxHoldDays: null,             // the square-off IS the time stop
    minEntryDTE: 0,
    exitBufferDays: 0,
    signalPersistence: 1,          // first mismatching poll exits (as before)
    plannedHoldDays: 0             // theta gate off — decay is intraday noise
  },

  positional: {
    name: "positional",
    product: "D",
    pollMs: 5 * 60000,             // 5 min — decisions are daily, MTM hourly
    trend: { source: "daily-ma", fast: 20, slow: 50 },
    trendRefreshMs: 60 * 60000,    // daily candles barely move intraday
    squareOff: false,
    maxHoldDays: 30,               // playbook: positional ≈ up to 1 month
    minEntryDTE: 10,
    exitBufferDays: 2,
    signalPersistence: 3,
    plannedHoldDays: 10
  },

  swing: {
    name: "swing",
    product: "D",
    pollMs: 15 * 60000,            // 15 min
    trend: { source: "daily-ma", fast: 100, slow: 200 }, // playbook investment rule
    trendRefreshMs: 60 * 60000,
    squareOff: false,
    maxHoldDays: 90,               // playbook: swing ≈ up to 3 months
    minEntryDTE: 30,
    exitBufferDays: 5,
    signalPersistence: 5,
    plannedHoldDays: 30
  }
};

let active = HORIZONS.intraday;

// Switch the engine onto a horizon profile (env HORIZON=... in headless
// modes, the startup prompt in live mode). Also retunes the poll cadence.
function activateHorizon(name) {
  const key = String(name || "intraday").toLowerCase();
  const profile = HORIZONS[key];
  if (!profile) {
    console.warn(`⚠️ Unknown horizon "${name}" — staying on ${active.name}`);
    return active;
  }
  active = profile;
  if (profile.pollMs) CONFIG.pollMs = profile.pollMs;

  console.log("⏱️ HORIZON:", profile.name.toUpperCase());
  console.log(
    `   product ${profile.product} | poll ${profile.pollMs / 1000}s | ` +
      `trend ${profile.trend.source === "daily-ma"
        ? `${profile.trend.fast}/${profile.trend.slow} daily SMA`
        : "5-min candles (30m)"}`
  );
  console.log(
    `   squareOff ${profile.squareOff ? "15:20 IST" : "off"} | ` +
      `maxHold ${profile.maxHoldDays ?? "—"}d | minEntryDTE ${profile.minEntryDTE}d | ` +
      `expiryBuffer ${profile.exitBufferDays}d | signalPersistence ${profile.signalPersistence}`
  );
  return active;
}

function getActiveHorizon() {
  return active;
}

module.exports = { HORIZONS, activateHorizon, getActiveHorizon };
