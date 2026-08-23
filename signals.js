/**
 * SIGNALS — the signal generator: side-aware OI build-up classification
 * (FIX 1), full chain analysis, bias, bias-relative confidence (FIX 2),
 * strategy scoring, and the intraday candle trend.
 *
 * Owns two pieces of session state:
 *   prevLtp           tick-to-tick premium comparison (internal)
 *   candleTrend       written here, read everywhere via runtime
 */
const { CONFIG } = require("./config");
const { istTimestamp } = require("./clock");
const { fetchCandles, fetchDailyCandles } = require("./upstox-api");
const { getActiveHorizon } = require("./horizons");
const runtime = require("./runtime");

/* ═══════════════════════════════════════════════════════════════════════
 * BUILD-UP CLASSIFICATION  (FIX 1)
 * ═══════════════════════════════════════════════════════════════════════ */

// FIX 1 — Side-aware option build-up classification.
// Playbook "Option OI Analysis": "Call OI represents Call Sellers, Put OI
// represents Put Sellers". OI is read through the SELLER lens, so the
// SAME premium/OI move means OPPOSITE things on the two sides:
//
//   side  premium  OI   label            market read           direction
//   CE      ↑      ↑    Call Buying      longs attacking up    Bullish
//   CE      ↓      ↑    Call Writing     sellers capping       Bearish
//   CE      ↓      ↓    Call Unwinding   call longs bailing    Bearish
//   CE      ↑      ↓    Call Covering    call sellers trapped  Bullish
//   PE      ↑      ↑    Put Buying       longs attacking down  Bearish
//   PE      ↓      ↑    Put Writing      sellers supporting    Bullish
//   PE      ↓      ↓    Put Unwinding    put longs bailing     Bullish
//   PE      ↑      ↓    Put Covering     put sellers trapped   Bearish
//
// Sample data (NIFTY 24600 strike, one 60s poll):
//   CE ltp 120 → 132 (+12), OI 420000 → 500000 (+80000)
//     → Call Buying → Bullish, ΔOI weight 80000
//   PE ltp 95 → 88 (−7),  OI 520000 → 700000 (+180000)
//     → Put Writing → Bullish, ΔOI weight 180000
//   The pre-fix code pooled that PE row as "Fresh Short" → Bearish: put
//   WRITING — the playbook's support signal ("doesn't go down / goes
//   up") — was being counted as a sell signal.
//
// Zero premium change or zero OI change carries no information → Neutral.
function classifyOptionSide(optionType, priceChange, oiChange) {
  if (!priceChange || !oiChange) return { label: "Neutral", direction: "Neutral" };

  const priceUp = priceChange > 0;
  const oiUp = oiChange > 0;

  if (optionType === "CE") {
    if (priceUp && oiUp)  return { label: "Call Buying",    direction: "Bullish" };
    if (!priceUp && oiUp) return { label: "Call Writing",   direction: "Bearish" };
    if (!priceUp)         return { label: "Call Unwinding", direction: "Bearish" };
    return                       { label: "Call Covering",  direction: "Bullish" };
  }

  // PE — the mirror image: put OI is SUPPORT, not selling pressure.
  if (priceUp && oiUp)  return { label: "Put Buying",    direction: "Bearish" };
  if (!priceUp && oiUp) return { label: "Put Writing",   direction: "Bullish" };
  if (!priceUp)         return { label: "Put Unwinding", direction: "Bullish" };
  return                       { label: "Put Covering",  direction: "Bearish" };
}

// Strike closest to spot = at-the-money strike.
function getATMStrike(chain, spot) {
  return chain.reduce((prev, curr) =>
    Math.abs(curr.strike_price - spot) < Math.abs(prev.strike_price - spot)
      ? curr
      : prev
  ).strike_price;
}

/* ═══════════════════════════════════════════════════════════════════════
 * CANDLE TREND — horizon-aware
 *   intraday    → last six 5-min candles (~30 min momentum)
 *   positional  → 20/50 daily SMA crossover
 *   swing       → 100/200 daily SMA crossover (playbook investment rule:
 *                 "100 day MA moves above 200 day MA" = uptrend)
 * ═══════════════════════════════════════════════════════════════════════ */

let lastCandleRefresh = 0;

// Simple moving average of the LAST `period` closes; null when there is
// not enough history.
function sma(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((s, c) => s + c, 0) / period;
}

// Intraday trend: last six 5-minute closes (~30 min): > +0.1% Up,
// < −0.1% Down, otherwise Flat. The SAME candle response also yields two
// entry confirmations for free (no extra API call):
//   VWAP         Σ(typical price × volume) / Σ(volume) over today — the
//                day-anchor the alignment gate prefers over the first
//                spot reading
//   volumeSurge  max volume of the last two candles ÷ average of the rest
//                (two, because the newest candle is usually still forming
//                and would understate) — the volume-surge entry gate
async function refreshIntradayTrend() {
  const candles = await fetchCandles(CONFIG.instrumentKey, "minutes", 5);
  if (candles.length < 6) {
    // fewer than six 5-min candles — e.g. the first ~30 min of the session
    runtime.setCandleTrend(null);
    runtime.setVwap(null);
    runtime.setVwapRef(null);
    runtime.setVolumeSurge(null);
    return;
  }
  const recent = candles.slice(-6);
  const first = recent[0].close;
  const last = recent[recent.length - 1].close;
  const pct = first ? ((last - first) / first) * 100 : 0;
  const trend = pct > 0.1 ? "Up" : pct < -0.1 ? "Down" : "Flat";
  runtime.setCandleTrend(trend);

  // Volume source: INDEX instruments trade no volume (their candles carry
  // 0), so VWAP/volume fall back to the near-month FUTURES candles when
  // the underlying's are volume-less and a futures key is known. vwapRef
  // keeps the comparison basis-consistent: futures trade at a basis to
  // spot, so a futures-sourced VWAP is compared against the FUTURES price
  // (the same candles' last close), never against index spot. vwapRef
  // null = VWAP is in underlying space, compare live spot as usual.
  let volCandles = candles;
  let vwapRef = null;
  if (!candles.some(c => c.volume > 0) && CONFIG.futuresKey) {
    try {
      volCandles = await fetchCandles(CONFIG.futuresKey, "minutes", 5);
      vwapRef = volCandles.length ? volCandles[volCandles.length - 1].close : null;
    } catch (e) {
      volCandles = [];
      console.error("Futures candles failed — VWAP/volume gates inactive:", e.response?.status || e.message);
    }
  }

  let pv = 0, vol = 0;
  for (const c of volCandles) {
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * (c.volume || 0);
    vol += c.volume || 0;
  }
  const vwap = vol > 0 ? Number((pv / vol).toFixed(2)) : null;
  runtime.setVwap(vwap);
  runtime.setVwapRef(vwap != null ? vwapRef : null);

  let surge = null;
  if (volCandles.length >= 6) {
    const rest = volCandles.slice(0, -2);
    const restAvg = rest.reduce((s, c) => s + (c.volume || 0), 0) / rest.length;
    const lastVol = Math.max(...volCandles.slice(-2).map(c => c.volume || 0));
    surge = restAvg > 0 ? Number((lastVol / restAvg).toFixed(2)) : null;
  }
  runtime.setVolumeSurge(surge);

  console.log(
    `🕯️ CANDLE TREND (30m): ${trend} (${pct.toFixed(2)}%) | VWAP ${vwap ?? "n/a"}` +
      `${vwapRef != null ? ` (futures, ref ${vwapRef})` : ""} | vol surge ${surge ?? "n/a"}×`
  );
}

// Daily SMA-crossover trend for positional/swing (playbook MA rule).
// Sample data: closes ending [... 24700, 24730, 24760], fast=20, slow=50
//   SMA20 24810.2 > SMA50 24512.7 × 1.001 → "Up"
// A ±0.1% dead band around the slow SMA maps a near-touch crossover to
// "Flat" instead of flip-flopping Up/Down on every refresh.
async function refreshDailyMaTrend(horizon) {
  const { fast, slow } = horizon.trend;
  // slow SMA needs `slow` TRADING days — fetch ~1.6× calendar days + cushion
  const spanDays = Math.ceil(slow * 1.6) + 10;
  const candles = await fetchDailyCandles(CONFIG.instrumentKey, spanDays);
  const closes = candles.map(c => c.close);

  const fastMA = sma(closes, fast);
  const slowMA = sma(closes, slow);
  if (fastMA === null || slowMA === null) {
    runtime.setCandleTrend(null);
    console.log(
      `🕯️ DAILY TREND: not enough history (${closes.length} closes, need ${slow}) — trend unknown`
    );
    return;
  }

  const trend =
    fastMA > slowMA * 1.001 ? "Up" :
    fastMA < slowMA * 0.999 ? "Down" :
    "Flat";
  runtime.setCandleTrend(trend);
  console.log(
    `🕯️ DAILY TREND (${fast}/${slow} SMA): ${trend} ` +
      `(SMA${fast} ${fastMA.toFixed(1)} vs SMA${slow} ${slowMA.toFixed(1)})`
  );
}

// Recompute the trend for the ACTIVE horizon. Trend null when candles are
// unavailable — the trend check then drops out of the confidence score
// instead of failing it.
async function refreshCandleTrend() {
  lastCandleRefresh = Date.now();
  const horizon = getActiveHorizon();
  try {
    if (horizon.trend.source === "daily-ma") await refreshDailyMaTrend(horizon);
    else await refreshIntradayTrend();
  } catch (e) {
    runtime.setCandleTrend(null);
    console.error("Candle fetch failed — trend unknown:", e.response?.data || e.message);
  }
}

// Interval-gated wrapper — the engine calls this every tick, the fetch
// only happens on the horizon's cadence (5 min intraday, hourly daily-MA).
async function maybeRefreshCandleTrend() {
  const refreshMs = getActiveHorizon().trendRefreshMs || CONFIG.candleRefreshMs;
  if (Date.now() - lastCandleRefresh < refreshMs) return;
  console.log("Refreshing candle trend...");
  await refreshCandleTrend();
  console.log("Candle trend refreshed.");
}

/* ═══════════════════════════════════════════════════════════════════════
 * FUTURES BUILD-UP — the classic single-series confirmation. The near-
 * month future has ONE price and ONE OI: poll-to-poll deltas classify as
 *   ΔP↑ ΔOI↑  Long Buildup     → Bullish
 *   ΔP↓ ΔOI↑  Short Buildup    → Bearish
 *   ΔP↓ ΔOI↓  Long Unwinding   → Bearish
 *   ΔP↑ ΔOI↓  Short Covering   → Bullish
 * Far cleaner than the option chain's 20 noisy strike-level series — the
 * entry gate blocks directional trades the futures flow CONTRADICTS.
 * ═══════════════════════════════════════════════════════════════════════ */

let prevFut = null; // { ltp, oi } of the previous poll's futures quote

// Feed one futures quote row (from fetchQuotes) — updates the runtime
// buildup the entry gate reads. First poll only seeds history; a missing
// quote leaves the previous read in place (stale beats fabricated).
function updateFuturesBuildup(quote) {
  const ltp = quote?.last_price;
  const oi = quote?.oi;
  if (ltp == null || oi == null) return;

  if (prevFut) {
    const dP = ltp - prevFut.ltp;
    const dOI = oi - prevFut.oi;
    let label = "Neutral", direction = "Neutral";
    if (dP > 0 && dOI > 0) { label = "Long Buildup"; direction = "Bullish"; }
    else if (dP < 0 && dOI > 0) { label = "Short Buildup"; direction = "Bearish"; }
    else if (dP < 0 && dOI < 0) { label = "Long Unwinding"; direction = "Bearish"; }
    else if (dP > 0 && dOI < 0) { label = "Short Covering"; direction = "Bullish"; }
    runtime.setFuturesBuildup({ label, direction });
    console.log(`📈 FUTURES: ${label} (ΔP ${dP.toFixed(2)}, ΔOI ${dOI}) → ${direction}`);
  }
  prevFut = { ltp, oi };
}

/* ═══════════════════════════════════════════════════════════════════════
 * ANALYSIS — OI totals, PCR, S/R, bias, confidence, strategy scores
 * ═══════════════════════════════════════════════════════════════════════ */

// Previous tick's LTP per option (key: "strike|CE"). Price change is
// measured tick-to-tick against the last poll, held in memory; the first
// tick seeds from the chain's close_price (previous session) when present.
let prevLtp = new Map();

// Full chain analysis: OI totals, PCR, S/R levels, build-up direction,
// IV, Greeks, market bias, confidence score, and ranked strategy scores.
function analyze(chain, marketPcr) {
  const candleTrend = runtime.getCandleTrend();

  // Spot: the rich chain carries it per row as underlying_spot_price; the
  // flat live chain has none, so fall back to a put-call parity estimate —
  // at the strike where CE and PE prices are closest,
  // spot ≈ strike + (CE − PE).
  let spot = chain.find(r => r.underlying_spot_price)?.underlying_spot_price ?? 0;
  if (!spot) {
    let best = null;
    for (const row of chain) {
      const diff = Math.abs(row.call_options.market_data.ltp - row.put_options.market_data.ltp);
      if (!best || diff < best.diff) best = { row, diff };
    }
    if (best) {
      spot =
        best.row.strike_price +
        (best.row.call_options.market_data.ltp - best.row.put_options.market_data.ltp);
    }
  }
  const atmStrike = getATMStrike(chain, spot);

  // Only look at strikes near the money — far wings just add noise.
  const filteredChain = chain.filter(
    row => Math.abs(row.strike_price - atmStrike) <= CONFIG.strikeRange
  );

  let totalCallOI = 0;
  let totalPutOI = 0;
  let totalIV = 0;
  let ivCount = 0;

  // FIX 1 totals: every CE/PE row resolves to a market DIRECTION via the
  // seller-lens table in classifyOptionSide, weighted by |ΔOI|.
  let bullishCount = 0;
  let bearishCount = 0;
  let bullishOI = 0;
  let bearishOI = 0;
  // Per-label breakdown (Call Buying, Put Writing, ...) for the signal
  // log and the Dashboard "Buildup" column.
  const buildupByLabel = {};

  // V2 Greeks. CE and PE deltas are kept SEPARATE — averaging |delta| of
  // both sides into one number carries no direction.
  let totalCallDelta = 0;
  let totalPutDelta = 0;
  let totalTheta = 0;
  let totalGamma = 0;
  let totalVega = 0;
  let sideCount = 0;

  // LTPs seen this tick — becomes prevLtp for the next poll's comparison.
  const nextLtp = new Map();

  filteredChain.forEach(row => {
    const ce = row.call_options;
    const pe = row.put_options;

    totalCallOI += ce.market_data.oi;
    totalPutOI += pe.market_data.oi;

    // IV lives in option_greeks in the rich chain; the flat feed keeps it
    // (when present at all) in market_data — accept either.
    totalIV +=
      (ce.option_greeks.iv || ce.market_data.iv || 0) +
      (pe.option_greeks.iv || pe.market_data.iv || 0);
    ivCount += 2;

    const ceG = ce.option_greeks || {};
    const peG = pe.option_greeks || {};
    totalCallDelta += Math.abs(ceG.delta || 0);
    totalPutDelta += Math.abs(peG.delta || 0);
    totalTheta += Math.abs(ceG.theta || 0) + Math.abs(peG.theta || 0);
    totalGamma += Math.abs(ceG.gamma || 0) + Math.abs(peG.gamma || 0);
    totalVega += Math.abs(ceG.vega || 0) + Math.abs(peG.vega || 0);
    sideCount += 2;

    // OI change was computed during normalization: oi − prev_oi (chain)
    const ceOIChange = ce.change_in_oi || 0;
    const peOIChange = pe.change_in_oi || 0;

    // Price change = current LTP vs the previous poll's LTP (in-memory).
    // First tick has no poll history — seed from the chain's close_price
    // (previous session) so build-up classification works immediately;
    // flat feeds without close_price start Neutral, as before.
    const ceKey = `${row.strike_price}|CE`;
    const peKey = `${row.strike_price}|PE`;
    const cePriceChange =
      ce.market_data.ltp -
      (prevLtp.get(ceKey) ?? ce.market_data.close_price ?? ce.market_data.ltp);
    const pePriceChange =
      pe.market_data.ltp -
      (prevLtp.get(peKey) ?? pe.market_data.close_price ?? pe.market_data.ltp);
    nextLtp.set(ceKey, ce.market_data.ltp);
    nextLtp.set(peKey, pe.market_data.ltp);

    // Classify CE and PE SEPARATELY through the seller lens — the same
    // premium/OI move means opposite directions on the two sides (FIX 1).
    for (const item of [
      { cls: classifyOptionSide("CE", cePriceChange, ceOIChange), oi: Math.abs(ceOIChange) },
      { cls: classifyOptionSide("PE", pePriceChange, peOIChange), oi: Math.abs(peOIChange) }
    ]) {
      if (item.cls.direction === "Neutral") continue;

      if (item.cls.direction === "Bullish") { bullishCount++; bullishOI += item.oi; }
      else { bearishCount++; bearishOI += item.oi; }

      const bucket = (buildupByLabel[item.cls.label] =
        buildupByLabel[item.cls.label] || { count: 0, oi: 0 });
      bucket.count++;
      bucket.oi += item.oi;

      // Per-strike trace — opt-in, it's up to 2 lines per strike per poll.
      if (process.env.DEBUG_SIGNALS === "1") {
        console.log(
          `   🔎 ${row.strike_price} ${item.cls.label} → ${item.cls.direction} (ΔOI ${item.oi})`
        );
      }
    }
  });

  // Remember this tick's LTPs for the next poll's price-change comparison
  prevLtp = nextLtp;

  // Highest-OI strikes act as resistance (calls) and support (puts).
  const topCalls = [...filteredChain]
    .sort((a, b) => b.call_options.market_data.oi - a.call_options.market_data.oi)
    .slice(0, 3);

  const topPuts = [...filteredChain]
    .sort((a, b) => b.put_options.market_data.oi - a.put_options.market_data.oi)
    .slice(0, 3);

  // PCR: computed locally from the summed OI over the analyzed strike
  // range (marketPcr stays null now that the pcr endpoint call is gone).
  const localPcr = totalCallOI > 0 ? Number((totalPutOI / totalCallOI).toFixed(2)) : 0;
  const pcr = marketPcr != null ? Number(marketPcr) : localPcr;
  const avgIV = ivCount > 0 ? Number((totalIV / ivCount).toFixed(2)) : 0;

  const strikeCount = filteredChain.length || 1;
  const avgCallDelta = Number((totalCallDelta / strikeCount).toFixed(3));
  const avgPutDelta = Number((totalPutDelta / strikeCount).toFixed(3));
  const avgTheta = Number((totalTheta / (sideCount || 1)).toFixed(3));
  const avgGamma = Number((totalGamma / (sideCount || 1)).toFixed(4));
  const avgVega = Number((totalVega / (sideCount || 1)).toFixed(3));

  // Data availability — the flat live chain carries no greeks/IV. Missing
  // data makes the related checks drop out of scoring instead of always
  // failing.
  const hasGreeks = totalCallDelta + totalPutDelta > 0;
  const hasIV = totalIV > 0;

  // Playbook bias: OI-weighted flow must DOMINATE (1.5×); unconvincing →
  // Range. The old PCR veto (Bullish also needed pcr > 1) is gone: local
  // PCR over ATM±strikeRange stayed 0.65–0.99 across four straight
  // sessions — calls simply carry more OI in this market — so Bullish was
  // structurally unreachable. On 2026-08-13 the 24319→24411 rally ran
  // tick after tick with 10–40× bullish flow dominance while bias sat in
  // Range/Bearish and the bot kept buying puts on an up day. PCR still
  // earns or denies confidence points (pcrAgrees) and strategy-score
  // points — it advises, it no longer vetoes.
  let bias = "Range";
  if (bullishOI > bearishOI * 1.5) bias = "Bullish";
  else if (bearishOI > bullishOI * 1.5) bias = "Bearish";

  // Signal log — one block per poll so every bias decision is auditable.
  const buildupSummary =
    Object.entries(buildupByLabel)
      .map(([label, b]) => `${label} ${b.count}x/${b.oi}`)
      .join(" | ") || "no build-up";

  console.log("🧭 SIGNAL | option build-up (seller lens):");
  console.log(`   ${buildupSummary}`);
  console.log(
    `   Bullish OI ${bullishOI} (${bullishCount} sides) vs ` +
      `Bearish OI ${bearishOI} (${bearishCount} sides) | PCR ${pcr} → Bias: ${bias}`
  );

  // FIX 2 — V2 confidence (0–100), bias-RELATIVE. Every check asks "does
  // this tool AGREE with the derived bias?" instead of hard-coding bullish
  // conditions. The old gate (pcr > 1.1, bullish-OI dominance, bullish
  // counts) let a Bearish tick earn at most 60/120 = 50 — permanently
  // below the 70 trade filter, so Bear Put Spread could never trade even
  // at a perfect strategy score.
  //
  // Sample data — bearish tick, all data present:
  //   bias Bearish | pcr 0.84 | bearishOI 910000 vs bullishOI 320000
  //   ✅ PCR agrees with bias (0.84 < 0.9)     +20
  //   ✅ OI dominance agrees (2.8× bearish)    +20
  //   ✅ build-up count agrees (14 vs 6)       +20
  //   ✅ avgPutDelta 0.46 > 0.4                +20
  //   ✅ avgIV 13.8 > 10                       +20
  //   ✅ candle trend Down matches bias        +20
  //   → 120/120 → confidence 100   (pre-fix: 60/120 → 50 → NO TRADE)
  const directionalDelta = bias === "Bearish" ? avgPutDelta : avgCallDelta;
  const trendMatches =
    (bias === "Bullish" && candleTrend === "Up") ||
    (bias === "Bearish" && candleTrend === "Down") ||
    (bias === "Range" && candleTrend === "Flat");

  // Agreement predicates. For Range, "agrees" means genuinely balanced
  // (PCR pinned near 1, neither side dominating) — a Range bias that came
  // from MIXED signals fails these and scores low, by design.
  const pcrAgrees =
    bias === "Bullish" ? pcr > 1.1 :
    bias === "Bearish" ? pcr < 0.9 :
    pcr >= 0.9 && pcr <= 1.1;
  const oiDominanceAgrees =
    bias === "Bullish" ? bullishOI > bearishOI * 1.5 :
    bias === "Bearish" ? bearishOI > bullishOI * 1.5 :
    bullishOI <= bearishOI * 1.5 && bearishOI <= bullishOI * 1.5;
  const countAgrees =
    bias === "Bullish" ? bullishCount > bearishCount :
    bias === "Bearish" ? bearishCount > bullishCount :
    bullishCount <= bearishCount * 1.5 && bearishCount <= bullishCount * 1.5;

  // Rescaled over available data: the delta/IV/candle checks drop out of
  // the denominator when the feed carries no greeks/IV/candles, instead
  // of capping confidence below the trade filter forever.
  // Rows: [name, data available?, condition, points]
  const confidenceChecks = [
    ["PCR agrees with bias",          true,                 pcrAgrees,              20],
    ["OI dominance agrees with bias", true,                 oiDominanceAgrees,      20],
    ["Build-up count agrees",         true,                 countAgrees,            20],
    ["Directional |delta| > 0.4",     hasGreeks,            directionalDelta > 0.4, 20],
    // Upper bound added: expiry-day feeds produced AvgIV up to 260 (with
    // AvgTheta in the thousands) and the old "> 10" check happily awarded
    // +20 confidence for it. IV that high isn't conviction, it's a broken
    // or gamma-cliff reading — treat it as failing the check.
    ["Avg IV sane (10–80)",           hasIV,                avgIV > 10 && avgIV < 80, 20],
    ["Candle trend matches bias",     candleTrend !== null, trendMatches,           20]
  ];

  let confEarned = 0;
  let confPossible = 0;
  console.log(`🎯 CONFIDENCE checks (relative to bias: ${bias}):`);
  for (const [name, available, cond, pts] of confidenceChecks) {
    if (!available) {
      console.log(`   ⏭️  ${name} — no data, dropped from scoring`);
      continue;
    }
    confPossible += pts;
    if (cond) confEarned += pts;
    console.log(`   ${cond ? "✅" : "❌"} ${name} +${cond ? pts : 0}/${pts}`);
  }
  const confidence = confPossible ? Math.round((confEarned / confPossible) * 100) : 0;
  console.log(`   Score: ${confEarned}/${confPossible} → confidence ${confidence}`);

  // V2 strategy scoring engine — each strategy earns points for the market
  // conditions that favor it; the highest score becomes the recommendation.
  // Each score is rescaled to 0–100 over the criteria whose data exists
  // in this feed, so strategies stay comparable across rich/flat feeds.
  const scoreOf = checks => {
    let earned = 0;
    let possible = 0;
    for (const [available, cond, pts] of checks) {
      if (!available) continue;
      possible += pts;
      if (cond) earned += pts;
    }
    return possible ? Math.round((earned / possible) * 100) : 0;
  };

  const strategies = [
    // Naked legs carry a `naked` flag: the sort below hands them a TIED
    // score only at 100 — i.e. only when every stricter check (2.5× OI
    // dominance, build-up breadth, confirmed trend) fired. At sub-100
    // ties the defined-risk spread stays on top: a replay of 2026-08-13
    // showed a 75–75 tie putting a naked ATM call into a flow whipsaw for
    // roughly twice the spread's loss.
    //
    // PCR is NOT a naked criterion (2026-08-14): local PCR over
    // ATM±strikeRange sits 0.65–0.99 in this market every session, so the
    // old `pcr > 1.15` gate capped Buy Call at 75 forever — the naked tier
    // was FIRST in the list but could never reach the 100 it needs to
    // lead. Same defect class as the removed PCR bias veto: PCR advises
    // (it still earns confidence points), it doesn't veto.
    {
      // Naked long call — uncapped upside, full premium at risk, no short
      // leg to offset theta/vega. High-conviction tier: leads the ranking
      // whenever flow dominance, build-up breadth AND a confirmed trend
      // all agree (score 100), exits as a 5–10 pt scalp (see trade.js).
      // The old avgCallDelta > 0.55 check could NEVER fire: the chain-mean
      // |delta| over a symmetric ATM±strikeRange window is pinned ≈ 0.5 by
      // construction (observed 0.459–0.519 on every recorded tick), which
      // silently made naked legs unreachable.
      strategy: "Buy Call",
      naked: true,
      score: scoreOf([
        [true, bullishOI > bearishOI * 2.5, 40],
        [true, bullishCount > bearishCount * 2, 20],
        // HARD check ([true, ...]): while the trend is unknown it FAILS
        // instead of dropping out — no naked entries without a confirmed
        // trend (e.g. the first ~30 min before six 5-min candles exist).
        [true, bias === "Bullish" && candleTrend === "Up", 40]
      ])
    },
    {
      // Naked long put — mirror of Buy Call for the bearish case.
      strategy: "Buy Put",
      naked: true,
      score: scoreOf([
        [true, bearishOI > bullishOI * 2.5, 40],
        [true, bearishCount > bullishCount * 2, 20],
        [true, bias === "Bearish" && candleTrend === "Down", 40]
      ])
    },
    {
      strategy: "Bull Call Spread",
      score: scoreOf([
        [true, pcr > 1, 25],
        [true, bullishOI > bearishOI, 25],
        [hasGreeks, avgCallDelta > 0.4, 25],
        [true, bias === "Bullish", 25]
      ])
    },
    {
      strategy: "Bear Put Spread",
      score: scoreOf([
        [true, pcr < 1, 25],
        [true, bearishOI > bullishOI, 25],
        [hasGreeks, avgPutDelta > 0.4, 25],
        [true, bias === "Bearish", 25]
      ])
    },
    {
      strategy: "Iron Condor",
      score: scoreOf([
        [true, pcr >= 0.9 && pcr <= 1.1, 30],
        [true, Math.abs(bullishOI - bearishOI) < (bullishOI + bearishOI) * 0.2, 30],
        [hasIV, avgIV > 20, 40]
      ])
    },
    {
      // Pure volatility play — without any IV/greeks data it cannot be
      // justified, so it scores 0 on feeds that lack both.
      strategy: "Long Straddle",
      score: scoreOf([
        [hasIV, avgIV < 15, 40],
        [hasGreeks, avgGamma > 0.02, 30],
        [hasGreeks, avgVega > 1, 30]
      ])
    }
  ];

  // Score first. On ties: naked legs win ONLY a 100-score tie (full
  // conviction); every other tie keeps the defined-risk structure on top.
  strategies.sort((a, b) =>
    b.score - a.score ||
    (a.score === 100
      ? (b.naked ? 1 : 0) - (a.naked ? 1 : 0)
      : (a.naked ? 1 : 0) - (b.naked ? 1 : 0))
  );
  const top3 = strategies.slice(0, 3);

  console.log(
    "📋 STRATEGY scores:",
    strategies.map(s => `${s.strategy} ${s.score}`).join(" | ")
  );

  return {
    timestamp: istTimestamp(), // IST wall clock — what the sheets display
    spot,
    atmStrike,
    // Confirmation snapshots (journaled per poll so replays can validate
    // the gates): today's VWAP, latest volume-surge ratio, and the futures
    // build-up label. The engine refreshes futures BEFORE analyze().
    vwap: runtime.getVwap(),
    volumeSurge: runtime.getVolumeSurge(),
    futuresBuildup: runtime.getFuturesBuildup()?.label ?? "",
    pcr,
    S1: topPuts[0]?.strike_price,
    S2: topPuts[1]?.strike_price,
    S3: topPuts[2]?.strike_price,
    R1: topCalls[0]?.strike_price,
    R2: topCalls[1]?.strike_price,
    R3: topCalls[2]?.strike_price,
    bullishCount,
    bearishCount,
    bullishOI,
    bearishOI,
    buildupSummary,
    avgIV,
    bias,
    avgCallDelta,
    avgPutDelta,
    avgTheta,
    avgGamma,
    avgVega,
    candleTrend,
    confidence,
    strategy1: top3[0]?.strategy,
    strategy1Score: top3[0]?.score,
    strategy2: top3[1]?.strategy,
    strategy2Score: top3[1]?.score,
    strategy3: top3[2]?.strategy,
    strategy3Score: top3[2]?.score
  };
}

module.exports = {
  classifyOptionSide,
  getATMStrike,
  refreshCandleTrend,
  maybeRefreshCandleTrend,
  updateFuturesBuildup,
  analyze
};
