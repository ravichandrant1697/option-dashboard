/**
 * TICKLOG — the tick-by-tick journal (2026-10-07, NIFTY first).
 *
 * Everything the WebSocket delivers is written, as it arrives, to a CSV
 * per process (one per session half), plus an events CSV with every
 * decision the engine made in between — poll summaries, tick-entry gate
 * verdicts, entries, exits. Together they let the stream process be
 * replayed offline tick by tick: feed the ticks file through the exit
 * ladder / fresh-break gate / tick-entry rules exactly as the bot ran
 * them, or with changed parameters, and compare.
 *
 * Files (repo root, gitignored, sent to Telegram at the end of each run):
 *   ticks-YYYY-MM-DD-HHMM.csv    ts_ms, ts_ist, key, ltp, cp, ltq, ltt_ms, bid, bidQ, ask, askQ,
 *                                oi, iv, delta, gamma, theta, vega, vtt, atp, tbq, tsq
 *   events-YYYY-MM-DD-HHMM.csv   ts_ms, ts_ist, type, detail (JSON)
 *
 * Writes are buffered and appended every FLUSH_MS; nothing is ever read
 * back during the session. Off switch: TICKLOG=0 (or RULES.tickJournal
 * false). A write error is logged once and the journal stops — the
 * trading loop never depends on it.
 */
const fs = require("fs");
const path = require("path");
const { RULES } = require("./config");
const { istTimestamp, todayIST } = require("./clock");

const ENABLED = process.env.TICKLOG !== "0" && RULES.tickJournal !== false;
const FLUSH_MS = 2000;
const TICK_HEADER = "ts_ms,ts_ist,key,ltp,cp,ltq,ltt_ms,bid,bidQ,ask,askQ,oi,iv,delta,gamma,theta,vega,vtt,atp,tbq,tsq\n";
const EVENT_HEADER = "ts_ms,ts_ist,type,detail\n";

const stamp = (() => { const d = istTimestamp(); return `${todayIST()}-${d.slice(11, 13)}${d.slice(14, 16)}`; })();
const TICK_FILE = path.join(__dirname, `ticks-${stamp}.csv`);
const EVENT_FILE = path.join(__dirname, `events-${stamp}.csv`);

let tickBuf = [], eventBuf = [], failed = null, timer = null;
let tickCount = 0, eventCount = 0;

function ensureHeader(file, header) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, header);
}

function flush() {
  if (failed || (!tickBuf.length && !eventBuf.length)) return;
  try {
    if (tickBuf.length) { ensureHeader(TICK_FILE, TICK_HEADER); fs.appendFileSync(TICK_FILE, tickBuf.join("")); tickBuf = []; }
    if (eventBuf.length) { ensureHeader(EVENT_FILE, EVENT_HEADER); fs.appendFileSync(EVENT_FILE, eventBuf.join("")); eventBuf = []; }
  } catch (e) {
    failed = e.message;
    console.error(`ticklog: write failed (${failed}) — tick journal stopped, trading unaffected`);
  }
}

function arm() {
  if (timer || !ENABLED) return;
  timer = setInterval(flush, FLUSH_MS);
  if (timer.unref) timer.unref(); // never keeps the process alive on its own
  process.on("exit", flush);
}

const num = v => (v == null || Number.isNaN(v) ? "" : v);
const csv = s => { const t = String(s); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };

// One streamed tick, as stream.extract() shaped it (plus raw depth/volume fields).
function logTick(key, t) {
  if (!ENABLED || failed) return;
  const g = t.greeks || {};
  const now = Date.now();
  tickBuf.push([
    now, istTimestamp(), csv(key), num(t.ltp), num(t.cp), num(t.ltq), num(t.ltt), num(t.bid), num(t.bidQ), num(t.ask), num(t.askQ),
    num(t.oi), num(t.iv), num(g.delta), num(g.gamma), num(g.theta), num(g.vega), num(t.vtt), num(t.atp), num(t.tbq), num(t.tsq)
  ].join(",") + "\n");
  tickCount++;
  arm();
}

// One engine decision: type = poll | tick_gate | tick_entry | entry | exit | stream | note; detail = plain object.
function logEvent(type, detail) {
  if (!ENABLED || failed) return;
  let d = "";
  try { d = JSON.stringify(detail ?? {}); } catch { d = String(detail); }
  eventBuf.push([Date.now(), istTimestamp(), csv(type), csv(d)].join(",") + "\n");
  eventCount++;
  arm();
}

// The files this process has written (for the workflow's Telegram step / logs).
function files() {
  return [TICK_FILE, EVENT_FILE].filter(f => fs.existsSync(f));
}

function status() {
  return { enabled: ENABLED, failed, tickCount, eventCount, tickFile: path.basename(TICK_FILE), eventFile: path.basename(EVENT_FILE) };
}

module.exports = { logTick, logEvent, flush, files, status, ENABLED };
