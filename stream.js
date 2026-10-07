/**
 * STREAM — Upstox V3 market-data feed over WebSocket (protobuf frames).
 * Rewritten 2026-09-28: the old client expected a JSON relay and never
 * received a tick. This one authorizes, connects, subscribes and decodes
 * the native feed (MarketDataFeedV3.proto, committed next to this file).
 *
 * What the ticks feed:
 *   runtime.liveTicks  key → {ltp, cp, bid, ask, greeks, oi, iv, at}
 *   streamExitSweep    tick-level STOP / TARGET / PROFIT_LOCK / TIME_STOP
 *                      between the 3-min polls (the 45-s fastExitCheck
 *                      stands down while ticks are fresh — engine.js)
 *   (2026-10-07: console heartbeat removed — exits only)
 *
 * Subscriptions: the underlying + near futures on connect, the legs of
 * every open position (trade.js open/close hooks), and the ATM legs of the
 * latest plan (engine.js, rotated each poll) — a dozen keys, far under the
 * per-connection limits. Everything wanted is re-sent on reconnect.
 *
 * PROFIT_LOCK on ticks needs CONFIRMATION: the ladder arms on one print
 * above a rung and exits on one print back at it, and at tick speed the
 * bid/ask bounce (≈1% on a ₹10 SBIN option) would bank every +8% on noise.
 * A lock exit fires only when the price has stayed at/below the armed rung
 * for LOCK_CONFIRM_MS (5 s). STOP / TARGET / TIME_STOP stay immediate.
 *
 * Off switch: STREAM=0. Missing `ws` / `protobufjs`, a refused connection
 * (e.g. Upstox's per-user connection cap with three bots on one account)
 * or a dead socket all fall back to polling — the engine never depends on
 * a tick arriving.
 */
const path = require("path");
const axios = require("axios");
const { HOST, ACCESS_TOKEN, CONFIG } = require("./config");
const runtime = require("./runtime");
const { getState } = require("./state");
const { checkExit } = require("./pricing");

let WebSocketImpl = null;
let protobuf = null;
try { WebSocketImpl = require("ws"); } catch { /* npm install ws */ }
try { protobuf = require("protobufjs"); } catch { /* npm install protobufjs */ }

const PROTO_FILE = path.join(__dirname, "MarketDataFeedV3.proto");
const ENABLED = process.env.STREAM !== "0";
const MODE = process.env.STREAM_MODE || "full"; // ltpc | full | option_greeks | full_d30
const LOCK_CONFIRM_MS = Number(process.env.LOCK_CONFIRM_MS) || 5000;
const FRESH_MS = 15000;      // a tick older than this no longer counts as live
const MAX_BACKOFF_MS = 60000;

let FeedResponse = null;
let socket = null;
let connected = false;
let connecting = false;
let lastTickAt = 0;
let backoffMs = 5000;
let reconnectTimer = null;
let lastSweep = 0;
let disabledReason = null;
let ticksSeen = 0;

const wanted = new Set();     // every key we want streamed (re-sent on reconnect)
const subscribed = new Set(); // keys the server currently has
const planKeys = new Set();   // ATM legs of the latest plan (rotated per poll)

function log(msg) { console.log(`🔌 stream: ${msg}`); }

async function loadProto() {
  if (FeedResponse) return;
  const root = await protobuf.load(PROTO_FILE);
  FeedResponse = root.lookupType("com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse");
}

// The V3 feed URL is a short-lived, pre-authorized wss:// address.
async function authorize() {
  const r = await axios.get(`${HOST}v3/feed/market-data-feed/authorize`, {
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: "application/json" },
    timeout: 15000
  });
  const d = r.data?.data || {};
  const uri = d.authorized_redirect_uri || d.authorizedRedirectUri;
  if (!uri) throw new Error("authorize: no authorized_redirect_uri in response");
  return uri;
}

// Subscription control frames are JSON sent as BINARY frames.
function sendFrame(method, keys) {
  if (!socket || socket.readyState !== 1 || !keys.length) return false;
  const msg = { guid: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, method, data: { mode: MODE, instrumentKeys: keys } };
  socket.send(Buffer.from(JSON.stringify(msg)), { binary: true });
  return true;
}

function flush() {
  if (!connected) return;
  const ks = [...wanted].filter(k => !subscribed.has(k));
  if (ks.length && sendFrame("sub", ks)) { ks.forEach(k => subscribed.add(k)); log(`subscribed ${ks.length} key(s), total ${subscribed.size}`); }
}

function subscribe(keys) {
  for (const k of keys || []) if (k) wanted.add(k);
  flush();
}

function unsubscribe(keys) {
  const ks = (keys || []).filter(k => k && wanted.has(k) && !planKeys.has(k) && !positionKeys().has(k));
  ks.forEach(k => wanted.delete(k));
  const live = ks.filter(k => subscribed.has(k));
  if (live.length && sendFrame("unsub", live)) live.forEach(k => subscribed.delete(k));
}

function positionKeys() {
  const s = new Set();
  for (const pos of getState().open) for (const l of pos.legs) if (l.instrument_key) s.add(l.instrument_key);
  return s;
}

// ATM legs of the latest plan: keep the console's "plan" LTP live without
// letting the subscription list grow all day — keys that are neither in
// the new plan nor in an open position are dropped.
function syncPlanKeys(keys) {
  const next = new Set((keys || []).filter(Boolean));
  const gone = [...planKeys].filter(k => !next.has(k));
  planKeys.clear(); next.forEach(k => planKeys.add(k));
  unsubscribe(gone);
  subscribe([...next]);
}

function extract(feed) {
  const ff = feed.fullFeed || {};
  const mff = ff.marketFF || null;
  const ltpc = feed.ltpc || mff?.ltpc || ff.indexFF?.ltpc || feed.firstLevelWithGreeks?.ltpc || null;
  const greeks = mff?.optionGreeks || feed.firstLevelWithGreeks?.optionGreeks || null;
  const q = mff?.marketLevel?.bidAskQuote?.[0] || feed.firstLevelWithGreeks?.firstDepth || null;
  return {
    ltp: ltpc?.ltp ?? null,
    cp: ltpc?.cp ?? null,
    bid: q?.bidP ?? null,
    ask: q?.askP ?? null,
    greeks,
    oi: mff?.oi ?? feed.firstLevelWithGreeks?.oi ?? null,
    iv: mff?.iv ?? feed.firstLevelWithGreeks?.iv ?? null
  };
}

function onMessage(raw) {
  let msg;
  try {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    msg = FeedResponse.toObject(FeedResponse.decode(buf), { longs: Number, defaults: false });
  } catch { return; } // a non-protobuf frame (rare text acks) — ignore
  let n = 0;
  for (const [key, feed] of Object.entries(msg.feeds || {})) {
    const t = extract(feed);
    if (t.ltp == null) continue;
    runtime.liveTicks.set(key, { ...t, at: Date.now() });
    n++;
  }
  if (!n) return;
  lastTickAt = Date.now();
  if ((ticksSeen += n) <= n) log(`first ticks received (${n} key(s))`);
  streamExitSweep();
  streamEntrySweep();
}

// Tick entries (2026-10-07): hand the latest spot tick to engine.tickEntryCheck,
// which re-plans between polls. Uses the engine module only if the session
// already loaded it (never loads it here — stream-test.js stays feed-only,
// and engine ↔ stream would be a load-order cycle).
function streamEntrySweep() {
  let engine = null;
  try { engine = require.cache[require.resolve("./engine")]?.exports || null; } catch { /* no engine in this process */ }
  if (!engine || typeof engine.tickEntryCheck !== "function") return;
  engine.tickEntryCheck().catch(e => log(`tick entry failed: ${e.message}`));
}

function scheduleReconnect() {
  if (reconnectTimer || disabledReason) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectStream(); }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

async function connect() {
  await loadProto();
  const uri = await authorize();
  await new Promise((resolve, reject) => {
    const ws = new WebSocketImpl(uri, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: "*/*" },
      followRedirects: true,
      handshakeTimeout: 15000
    });
    let settled = false;
    ws.on("open", () => {
      settled = true; socket = ws; connected = true; backoffMs = 5000; subscribed.clear();
      log(`connected (${MODE})`);
      subscribe([CONFIG.instrumentKey, CONFIG.futuresKey]);
      subscribe([...positionKeys()]);
      flush();
      resolve();
    });
    ws.on("message", onMessage);
    ws.on("error", e => { log(`error: ${e.message}`); if (!settled) { settled = true; reject(e); } });
    ws.on("close", (code, reason) => {
      const wasConnected = connected;
      connected = false; if (socket === ws) socket = null; subscribed.clear();
      if (!settled) { settled = true; reject(new Error(`closed during handshake (${code})`)); return; }
      if (wasConnected) log(`closed (${code} ${reason || ""}) — reconnecting in ${backoffMs / 1000}s`);
      scheduleReconnect();
    });
  });
}

// Fire-and-forget entry point (session mode calls it once at startup).
function connectStream() {
  if (!ENABLED) { disabledReason = "STREAM=0"; log("disabled by STREAM=0 — polling only"); return; }
  if (!WebSocketImpl || !protobuf) { disabledReason = "deps"; log("disabled — run `npm install ws protobufjs`"); return; }
  if (connecting || connected) return;
  connecting = true;
  connect()
    .catch(e => {
      const status = e.response?.status;
      log(`connect failed${status ? ` (HTTP ${status})` : ""}: ${e.response?.data?.errors?.[0]?.message || e.message} — polling only until it reconnects`);
      scheduleReconnect();
    })
    .finally(() => { connecting = false; });
}

function hasFreshTicks(legs) {
  if (!connected) return false;
  for (const l of legs) {
    const t = l.instrument_key ? runtime.liveTicks.get(l.instrument_key) : null;
    if (!t || t.ltp == null || Date.now() - t.at > FRESH_MS) return false;
  }
  return legs.length > 0;
}

function netFromTicks(legs) {
  let net = 0;
  for (const l of legs) { const t = runtime.liveTicks.get(l.instrument_key); if (!t || t.ltp == null) return null; net += l.side === "BUY" ? t.ltp : -t.ltp; }
  return net;
}

// Tick-level exits. At most once per second; lock exits need confirmation.
function streamExitSweep() {
  const lastResult = runtime.getLastResult();
  const state = getState();
  if (!lastResult || !state.open.length) return;
  if (Date.now() - lastSweep < 1000) return;
  lastSweep = Date.now();
  const { closePosition } = require("./trade"); // lazy: trade ↔ stream
  for (const pos of [...state.open]) {
    if (runtime.closingIds.has(pos.id)) continue;
    if (!hasFreshTicks(pos.legs)) continue;
    const netNow = netFromTicks(pos.legs);
    if (netNow == null) continue;
    const exit = checkExit(pos, netNow, lastResult);
    if (!exit) { pos._lockBelowSince = null; continue; }
    if (exit.reason === "PROFIT_LOCK") {
      pos._lockBelowSince = pos._lockBelowSince || Date.now();
      if (Date.now() - pos._lockBelowSince < LOCK_CONFIRM_MS) continue; // wait for the pullback to hold
    }
    log(`EXIT ${exit.reason} | ${exit.outcome} | net ${netNow.toFixed(2)}`);
    closePosition(pos, netNow, exit.outcome, exit.reason); // async; guarded inside
  }
}

function status() {
  return {
    enabled: ENABLED && !disabledReason,
    connected,
    mode: MODE,
    subscribed: subscribed.size,
    lastTickAgeS: lastTickAt ? Math.round((Date.now() - lastTickAt) / 1000) : null,
    disabledReason
  };
}

module.exports = { connectStream, streamExitSweep, subscribe, unsubscribe, syncPlanKeys, hasFreshTicks, netFromTicks, status, isConnected: () => connected };
