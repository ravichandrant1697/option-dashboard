/**
 * STREAM — optional real-time ticks over WebSocket, for instant exits
 * between 60s polls. Expects a JSON relay: Upstox's native V3 feed is
 * protobuf over a short-lived authorized URL
 * (v3/feed/market-data-feed/authorize), NOT the {feeds:{...}} shape
 * parsed here — native protobuf frames fail JSON.parse and are ignored.
 */
const { CONFIG, ACCESS_TOKEN } = require("./config");
const runtime = require("./runtime");
const { getState } = require("./state");
const { checkExit } = require("./pricing");
const { closePosition } = require("./trade");

// Optional dependency — streaming silently disables when `ws` is absent.
let WebSocketImpl = null;
try {
  WebSocketImpl = require("ws");
} catch {
  /* run `npm install ws` to enable streaming */
}

// Throttle stamp for the stream-driven exit sweep.
let lastSweep = 0;

// Real-time exits between polls: when every leg of an open position has
// a fresh streamed tick (< 15s), evaluate stop/target immediately instead
// of waiting up to 60s for the next poll. The signal-change check reuses
// the most recent poll's analysis.
function streamExitSweep() {
  const lastResult = runtime.getLastResult();
  const state = getState();
  if (!lastResult || !state.open.length) return;
  if (Date.now() - lastSweep < 2000) return; // at most once per 2s
  lastSweep = Date.now();

  for (const pos of [...state.open]) {
    if (runtime.closingIds.has(pos.id)) continue;

    let netNow = 0;
    let complete = true;
    for (const leg of pos.legs) {
      const tick = leg.instrument_key ? runtime.liveTicks.get(leg.instrument_key) : null;
      if (!tick || tick.ltp === null || Date.now() - tick.at > 15000) {
        complete = false;
        break;
      }
      netNow += leg.side === "BUY" ? tick.ltp : -tick.ltp;
    }
    if (!complete) continue;

    const exit = checkExit(pos, netNow, lastResult);
    if (exit) closePosition(pos, netNow, exit.outcome, exit.reason); // async; guarded inside
  }
}

// Connect to the market-data stream and keep liveTicks fresh. Messages:
// { feeds: { "NSE_FO|12345": { ltpc:{ltp,cp}, marketLevel:{bidQty,askQty},
//   optionGreeks:{delta,gamma,theta,vega,iv} } } }
// Reconnects 5s after a drop. Needs CONFIG.wsUrl (UPSTOX_WS_URL env).
function connectStream() {
  if (!CONFIG.wsUrl) return; // no URL configured — polling only
  if (!WebSocketImpl) {
    console.log("Streaming disabled — run `npm install ws` to enable");
    return;
  }

  console.warn(
    "⚠️ Stream: this client expects JSON {feeds:{...}} — Upstox's native V3 feed is protobuf; use a JSON relay"
  );

  const socket = new WebSocketImpl(CONFIG.wsUrl, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}` }
  });

  socket.on("open", () => console.log("🔌 WebSocket stream connected"));

  socket.on("message", raw => {
    try {
      const msg = JSON.parse(raw.toString());
      for (const [key, feed] of Object.entries(msg.feeds || {})) {
        runtime.liveTicks.set(key, {
          ltp: feed.ltpc?.ltp ?? null,
          cp: feed.ltpc?.cp ?? null,
          greeks: feed.optionGreeks || null,
          at: Date.now()
        });
      }
      streamExitSweep();
    } catch {
      /* non-JSON frame — ignore */
    }
  });

  socket.on("error", e => console.error("WebSocket error:", e.message));
  socket.on("close", () => {
    console.log("WebSocket closed — reconnecting in 5s");
    setTimeout(connectStream, 5000);
  });
}

module.exports = { connectStream, streamExitSweep };
