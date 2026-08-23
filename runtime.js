/**
 * RUNTIME — mutable session state that crosses module boundaries.
 * Each field has exactly ONE writer; every other module reads through
 * the getters. Keeping this tiny and import-free breaks what would
 * otherwise be circular dependencies (engine ↔ stream ↔ trade).
 *
 *   candleTrend  written by signals.refreshCandleTrend  ("Up"|"Down"|"Flat"|null)
 *   lastResult   written by engine.run every poll        (latest analyze() output)
 *   liveTicks    written by stream on websocket messages (key → {ltp, cp, greeks, at})
 *   closingIds   claimed by trade.closePosition           (double-close guard)
 *   liveTrading  written by prompts.setupInstrument       (LIVE_TRADING=1 + typed YES)
 */

let candleTrend = null;
let lastResult = null;
let liveTrading = false;

// Latest streamed tick per instrument key: { ltp, cp, greeks, at }.
const liveTicks = new Map();

// Positions currently mid-close — guards against a double close when the
// stream sweep and the poll loop race on the same position.
const closingIds = new Set();

module.exports = {
  getCandleTrend: () => candleTrend,
  setCandleTrend: v => { candleTrend = v; },
  getLastResult: () => lastResult,
  setLastResult: v => { lastResult = v; },
  isLiveTrading: () => liveTrading,
  setLiveTrading: v => { liveTrading = !!v; },
  liveTicks,
  closingIds
};
