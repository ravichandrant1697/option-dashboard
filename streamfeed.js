/**
 * STREAMFEED — the WebSocket as the market-data source (2026-10-07, NIFTY).
 *
 * The REST option chain stays the SEED: one call at startup (and every
 * RULES.streamReseedMs) supplies the strike list, prev_oi, close_price and
 * the per-strike instrument keys. From then on every streamed tick updates
 * a live copy of that chain in place — ltp, oi, iv, Greeks, day volume —
 * and recomputes change_in_oi (oi − prev_oi), so signals.analyze() can run
 * on it exactly as on a fresh REST chain. The index tick is the spot; the
 * futures tick feeds the build-up read (price vs day open, OI vs the
 * session's first reading); 5-minute candles for the index (trend) and the
 * futures (VWAP, volume surge — volume = Δ of the cumulative vtt) are built
 * from the ticks, seeded once with the REST candles so VWAP covers the
 * whole day, not just the minutes since the socket connected.
 *
 * Freshness is explicit: chainFresh() needs a live index tick (< 15 s) and
 * a seed younger than 2 × streamReseedMs; the engine falls back to REST
 * whenever that fails, so a dead socket costs nothing but latency.
 */
const { CONFIG, RULES } = require("./config");
const { todayIST } = require("./clock");

const BUCKET_MS = 5 * 60000;
const SPOT_FRESH_MS = 15000;
const FUT_FRESH_MS = 60000;

let seed = null;          // live copy of the last REST chain (rows mutated by ticks)
let seedAt = 0;
let seedSpot = null;      // underlying_spot_price carried by the REST chain
const keyIndex = new Map(); // instrument_key → { row, side: "call_options" | "put_options" }
const updatedKeys = new Set();

let spot = null, spotAt = 0;
const fut = { ltp: null, oi: null, at: 0, dayOpen: null, dayOpenDate: null };

// key → { byBucket: Map<bucketStartMs, candle>, order: [bucketStartMs…], lastVtt }
const candleBooks = new Map();
const historySeeded = new Set(); // keys whose older buckets came from REST candles

function cloneSide(side) {
  if (!side) return { market_data: {}, option_greeks: {} };
  return { ...side, market_data: { ...(side.market_data || {}) }, option_greeks: { ...(side.option_greeks || {}) } };
}

// ---- chain ---------------------------------------------------------------

function seedChain(chain) {
  if (!Array.isArray(chain) || !chain.length) return;
  seed = chain.map(r => ({ ...r, call_options: cloneSide(r.call_options), put_options: cloneSide(r.put_options) }));
  seedAt = Date.now();
  seedSpot = seed.find(r => r.underlying_spot_price)?.underlying_spot_price ?? null;
  keyIndex.clear(); updatedKeys.clear();
  for (const row of seed) {
    for (const side of ["call_options", "put_options"]) {
      const k = row[side]?.instrument_key;
      if (k) keyIndex.set(k, { row, side });
    }
  }
}

// Instrument keys of the analysis window (ATM ± span) — what to stream.
function windowKeys(atmStrike, span) {
  if (!seed || !Number.isFinite(atmStrike)) return [];
  return seed
    .filter(r => Math.abs(r.strike_price - atmStrike) <= span)
    .flatMap(r => [r.call_options?.instrument_key, r.put_options?.instrument_key])
    .filter(Boolean);
}

function applyTick(key, t) {
  const now = Date.now();
  if (key === CONFIG.instrumentKey) {
    if (t.ltp != null) { spot = t.ltp; spotAt = now; pushCandle(key, t.ltp, null, now); }
    return;
  }
  if (CONFIG.futuresKey && key === CONFIG.futuresKey) {
    if (t.ltp != null) {
      fut.ltp = t.ltp; fut.at = now;
      if (t.oi != null) fut.oi = t.oi;
      const today = todayIST();
      if (fut.dayOpenDate !== today) { fut.dayOpen = t.ltp; fut.dayOpenDate = today; } // first tick of the day unless a quote seeded it
      pushCandle(key, t.ltp, t.vtt, now);
    }
    return;
  }
  const hit = keyIndex.get(key);
  if (!hit) return;
  const side = hit.row[hit.side];
  const md = side.market_data;
  if (t.ltp != null) md.ltp = t.ltp;
  if (t.oi != null) md.oi = t.oi;
  if (t.vtt != null) md.volume = t.vtt;
  if (t.iv != null) {
    const iv = t.iv > 0 && t.iv < 1 ? t.iv * 100 : t.iv; // the chain carries IV in percent
    md.iv = iv; side.option_greeks.iv = iv;
  }
  if (t.greeks) {
    const g = t.greeks;
    if (g.delta != null) side.option_greeks.delta = g.delta;
    if (g.theta != null) side.option_greeks.theta = g.theta;
    if (g.gamma != null) side.option_greeks.gamma = g.gamma;
    if (g.vega != null) side.option_greeks.vega = g.vega;
  }
  side.change_in_oi = md.prev_oi != null ? (md.oi || 0) - (md.prev_oi || 0) : 0;
  updatedKeys.add(key);
}

// The REST futures quote on a REST cycle pins the day open properly.
function seedFuturesOpen(quote) {
  const open = quote?.ohlc?.open;
  if (open != null) { fut.dayOpen = open; fut.dayOpenDate = todayIST(); }
  if (quote?.oi != null && fut.oi == null) fut.oi = quote.oi;
}

function chainFresh() {
  const now = Date.now();
  return !!seed && spot != null && now - spotAt < SPOT_FRESH_MS && now - seedAt < 2 * (RULES.streamReseedMs || 30 * 60000);
}

function needsReseed() {
  return !seed || Date.now() - seedAt >= (RULES.streamReseedMs || 30 * 60000);
}

// The live chain for analyze(): the seed rows with the live spot stamped on
// (analyze reads the first row carrying underlying_spot_price).
function liveChain() {
  if (!seed) return null;
  const s = spot ?? seedSpot;
  for (const row of seed) row.underlying_spot_price = s;
  return seed;
}

function futuresQuote() {
  const now = Date.now();
  if (fut.ltp == null || fut.oi == null || fut.dayOpen == null || now - fut.at > FUT_FRESH_MS) return null;
  return { last_price: fut.ltp, oi: fut.oi, ohlc: { open: fut.dayOpen } };
}

// ---- candles -------------------------------------------------------------

function book(key) {
  let b = candleBooks.get(key);
  if (!b) { b = { byBucket: new Map(), order: [], lastVtt: null }; candleBooks.set(key, b); }
  return b;
}

// vtt is the cumulative day volume → a bucket's volume = vtt at its last
// tick − vtt at the previous bucket's last tick. Index ticks carry none.
function pushCandle(key, price, vtt, now) {
  const b = book(key);
  const start = Math.floor(now / BUCKET_MS) * BUCKET_MS;
  let c = b.byBucket.get(start);
  if (!c) {
    c = { time: new Date(start).toISOString(), open: price, high: price, low: price, close: price, volume: 0, _vttStart: b.lastVtt ?? vtt ?? null };
    b.byBucket.set(start, c); b.order.push(start);
  }
  if (price > c.high) c.high = price;
  if (price < c.low) c.low = price;
  c.close = price;
  if (vtt != null) {
    if (c._vttStart == null) c._vttStart = vtt;
    c.volume = Math.max(0, vtt - c._vttStart);
    b.lastVtt = vtt;
  }
}

// Older REST candles fill the buckets the stream has not seen (seeded once
// per key per session) so VWAP / averages cover the whole day.
function seedCandles(key, restCandles) {
  if (historySeeded.has(key) || !Array.isArray(restCandles)) return;
  const b = book(key);
  const firstStream = b.order.length ? Math.min(...b.order) : Infinity;
  for (const rc of restCandles) {
    const start = Math.floor(new Date(rc.time).getTime() / BUCKET_MS) * BUCKET_MS;
    if (start >= firstStream || b.byBucket.has(start)) continue;
    b.byBucket.set(start, { time: new Date(start).toISOString(), open: rc.open, high: rc.high, low: rc.low, close: rc.close, volume: rc.volume || 0, _vttStart: null });
    b.order.push(start);
  }
  b.order.sort((x, y) => x - y);
  historySeeded.add(key);
}

function candles(key) {
  const b = candleBooks.get(key);
  if (!b) return [];
  return [...b.order].sort((x, y) => x - y).map(s => { const c = b.byBucket.get(s); return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }; });
}

// Enough tick-built index candles to replace the REST fetch (same threshold
// as refreshIntradayTrend's "fewer than six" rule).
function candlesReady() {
  const b = candleBooks.get(CONFIG.instrumentKey);
  return !!b && b.order.length >= 6;
}

function historyNeeded(key) {
  return !historySeeded.has(key);
}

function status() {
  const now = Date.now();
  return {
    seeded: !!seed,
    seedAgeS: seed ? Math.round((now - seedAt) / 1000) : null,
    indexAgeS: spotAt ? Math.round((now - spotAt) / 1000) : null,
    spot,
    updatedKeys: updatedKeys.size,
    futAgeS: fut.at ? Math.round((now - fut.at) / 1000) : null,
    candles: { index: candleBooks.get(CONFIG.instrumentKey)?.order.length ?? 0, futures: CONFIG.futuresKey ? (candleBooks.get(CONFIG.futuresKey)?.order.length ?? 0) : 0 }
  };
}

module.exports = { seedChain, windowKeys, applyTick, seedFuturesOpen, chainFresh, needsReseed, liveChain, futuresQuote, seedCandles, candles, candlesReady, historyNeeded, status, getSpot: () => spot };
