/**
 * STREAM-TEST — prove the V3 feed works before trusting it in a session.
 *
 *   node stream-test.js                      → underlying from config.js
 *   node stream-test.js "NSE_INDEX|Nifty 50" "NSE_EQ|INE062A01020"
 *
 * Connects, subscribes, prints every tick for 30 s, then exits 0 if at
 * least one tick arrived (1 otherwise). Needs UPSTOX_TOKEN in .env and
 * outbound wss:// (a corporate proxy may block it locally — run it on the
 * GitHub runner via the "Stream test" workflow input if so).
 */
const cfg = require("./config"); const { CONFIG } = cfg; const applyEnvConfig = cfg.applyEnvConfig || (() => {});
applyEnvConfig();
const runtime = require("./runtime");
const stream = require("./stream");

const keys = process.argv.slice(2).length ? process.argv.slice(2) : [CONFIG.instrumentKey];
console.log("stream-test: keys", keys.join(", "));
stream.connectStream();
stream.subscribe(keys);

const seen = new Map();
const started = Date.now();
const iv = setInterval(() => {
  for (const [k, t] of runtime.liveTicks) {
    if (seen.get(k) === t.at) continue;
    seen.set(k, t.at);
    console.log(`${new Date(t.at).toISOString().slice(11, 19)} ${k} ltp ${t.ltp} bid ${t.bid ?? "-"} ask ${t.ask ?? "-"}${t.greeks ? ` Δ${t.greeks.delta.toFixed(3)} iv ${t.iv}` : ""}`);
  }
  if (Date.now() - started > 30000) {
    clearInterval(iv);
    const st = stream.status();
    console.log("status:", JSON.stringify(st));
    console.log(seen.size ? `OK — ticks for ${seen.size} key(s)` : "NO TICKS — check token, market hours, connection limits, proxy");
    process.exit(seen.size ? 0 : 1);
  }
}, 1000);
