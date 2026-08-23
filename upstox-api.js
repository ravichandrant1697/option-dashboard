/**
 * UPSTOX-API — every HTTP call to Upstox lives here; no other module
 * builds a URL or touches axios for market/broker data.
 *
 * ENDPOINTS:
 *   v2/option/chain (api.upstox.com)  → the single market-data source:
 *       strikes, LTP, OI, prev_oi (→ OI change), close_price, volume,
 *       underlying_spot_price, per-side option_greeks (incl. iv)
 *   v3/historical-candle/intraday/{key}/{unit}/{interval} → candle trend
 *   v3/order/place (api-hft.upstox.com) → REAL order placement (opt-in only)
 *   v2/portfolio/long-term-holdings   → holdings snapshot ("Portfolio" sheet)
 *   v2/portfolio/short-term-positions → live broker positions ("Positions" sheet)
 *
 * Price change is measured tick-to-tick in memory by the signals module
 * (the first tick seeds from the chain's close_price); OI change is
 * oi − prev_oi from the chain itself.
 */
const axios = require("axios");
const zlib = require("zlib");
const { ACCESS_TOKEN, HOST, ORDER_HOST, CONFIG } = require("./config");
const { todayIST } = require("./clock");

function authHeaders() {
  return { Authorization: `Bearer ${ACCESS_TOKEN}`, Accept: "application/json" };
}


// Preflight: one cheap authenticated call (user profile) proves the token


// Wrap a flat live-chain side ({ltp, oi, volume} directly) into the rich
// shape (market_data + option_greeks) the rest of the engine expects.
// Rich sides pass through untouched.
function toRichSide(side) {
  if (!side) return { market_data: {}, option_greeks: {} };
  if (side.market_data) {
    side.option_greeks = side.option_greeks || {};
    return side;
  }
  return {
    ...side,
    market_data: {
      ltp: side.ltp ?? 0,
      oi: side.oi ?? 0,
      volume: side.volume ?? 0,
      iv: side.iv ?? 0
    },
    option_greeks: side.option_greeks || {}
  };
}

// Fetch everything the analyzer needs for one tick from the option-chain
// endpoint alone — it already carries spot (underlying_spot_price), OI,
// prev_oi (→ OI change), close_price, and per-side greeks + IV. The old
// v2/market/change-oi, v2/market/pcr and market-quote/option-greek calls
// are gone: option-greek is v3-only and capped at 50 keys, the Market
// Information APIs need expiry/date/interval params this code never sent,
// and everything they add is already in the chain. Returns
// { chain, marketPcr } with marketPcr null so analyze() falls back to the
// PCR computed from the chain's own OI totals.
async function fetchMarketData() {
  console.log("\n==================================================");
  console.log("🚀 fetchMarketData() Started");
  console.log("==================================================");

  const startTime = Date.now();

  try {
    console.log("🔑 Access Token Available :", !!ACCESS_TOKEN);
    console.log("🌐 HOST :", HOST);
    console.log("📌 Instrument Key :", CONFIG.instrumentKey);
    console.log("📅 Expiry Date :", CONFIG.expiryDate);

    console.log("➡ Option Chain :", `${HOST}v2/option/chain`);

    const chainRes = await axios.get(`${HOST}v2/option/chain`, {
      headers: authHeaders(),
      params: {
        instrument_key: CONFIG.instrumentKey,
        expiry_date: CONFIG.expiryDate
      }
    });

    console.log("✅ Option Chain API Success");

    // Full dump is opt-in (DEBUG_CHAIN=1) — it's the entire chain, and it
    // would print every poll.
    if (process.env.DEBUG_CHAIN === "1") {
      console.log(
        "FULL OPTION CHAIN RESPONSE:",
        JSON.stringify(chainRes.data, null, 2)
      );
    }

    const chain = chainRes.data?.data || [];

    console.log("📊 Total Strike Count :", chain.length);

    console.log("🔄 Normalizing Option Chain...");

    for (const row of chain) {

      row.call_options = toRichSide(row.call_options);
      row.put_options = toRichSide(row.put_options);

      // Change in OI straight from the chain: oi − prev_oi. The flat live
      // feed has no prev_oi → 0 → "Neutral" until history builds, as before.
      for (const side of [row.call_options, row.put_options]) {
        const md = side.market_data;
        side.change_in_oi =
          md.prev_oi != null ? (md.oi || 0) - (md.prev_oi || 0) : 0;
      }
    }

    console.log("✅ Normalization Completed");

    console.log("================================");
    console.log("✅ fetchMarketData Completed");
    console.log("📊 Strike Count :", chain.length);
    console.log("⏱ Time :", Date.now() - startTime, "ms");
    console.log("================================\n");

    // marketPcr: null → analyze() uses the PCR computed from the chain's
    // own OI totals (localPcr).
    return {
      chain,
      marketPcr: null
    };

  } catch (e) {

    console.error("================================");
    console.error("❌ fetchMarketData FAILED");

    if (e.response) {
      console.error("Status :", e.response.status);
      console.error("Headers :", e.response.headers);
      console.error("Response :", e.response.data);
    } else {
      console.error("Message :", e.message);
    }

    console.error("Stack :", e.stack);
    console.error("================================");

    throw e;
  }
}

// Fetch TODAY's candles from the V3 intraday endpoint
// (v3/historical-candle/intraday/{key}/{unit}/{interval} — the dated
// historical route excludes the current day). Rows arrive as arrays
// [timestamp, open, high, low, close, volume]; returned oldest-first.
async function fetchCandles(instrumentKey, unit, interval) {
  const response = await axios.get(
    `${HOST}v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${unit}/${interval}`,
    { headers: authHeaders() }
  );
  const rows = response.data?.data?.candles || [];
  return rows
    .map(c => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

// Fetch DAILY candles from the dated V3 route
// (v3/historical-candle/{key}/days/1/{to}/{from}) going calendarDaysBack
// from today — used by the positional/swing SMA trend, which needs up to
// 200 trading days (~290 calendar days) of closes. Same row format and
// oldest-first ordering as fetchCandles.
async function fetchDailyCandles(instrumentKey, calendarDaysBack) {
  const to = todayIST();
  const from = new Date(Date.now() - calendarDaysBack * 86400000)
    .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const response = await axios.get(
    `${HOST}v3/historical-candle/${encodeURIComponent(instrumentKey)}/days/1/${to}/${from}`,
    { headers: authHeaders() }
  );
  const rows = response.data?.data?.candles || [];
  return rows
    .map(c => ({ time: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }))
    .sort((a, b) => new Date(a.time) - new Date(b.time));
}

// Full market quotes for one or more instrument keys in a single call
// (v2/market-quote/quotes, comma-separated keys). Each row carries
// last_price, oi, volume and the top-5 bid/ask depth. QUIRK: the response
// object is keyed by "EXCHANGE:TradingSymbol", NOT by instrument key —
// every row carries its instrument_token (= the key), so the result is
// re-indexed into a Map keyed by instrument key for callers.
async function fetchQuotes(instrumentKeys) {
  const response = await axios.get(`${HOST}v2/market-quote/quotes`, {
    headers: authHeaders(),
    params: { instrument_key: instrumentKeys.join(",") }
  });
  const byKey = new Map();
  for (const row of Object.values(response.data?.data || {})) {
    if (row?.instrument_token) byKey.set(row.instrument_token, row);
  }
  return byKey;
}

// Download and parse an exchange's instruments master (every segment,
// including F&O). Several MB gzipped — called ONCE at startup by the
// contract auto-resolver, never on the hot path. exchange = "NSE" | "BSE"
// (SENSEX contracts live on BSE).
async function fetchInstruments(exchange = "NSE") {
  const response = await axios.get(
    `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`,
    { responseType: "arraybuffer", timeout: 120000 }
  );
  return JSON.parse(zlib.gunzipSync(Buffer.from(response.data)).toString("utf8"));
}

// Fetch the demat long-term holdings from the portfolio endpoint.
async function fetchHoldings() {
  const response = await axios.get(`${HOST}v2/portfolio/long-term-holdings`, {
    headers: authHeaders()
  });
  return response.data?.data || [];
}

// Fetch the live short-term (F&O/intraday) positions from the broker.
async function fetchPositions() {
  const response = await axios.get(`${HOST}v2/portfolio/short-term-positions`, {
    headers: authHeaders()
  });
  return response.data?.data || [];
}

// Place ONE real market order leg. product comes from the horizon:
// "I" = intraday (auto-squared by the broker), "D" = delivery/carry-forward
// (positional/swing — held overnight, SPAN margin applies to short legs).
// validity DAY + price 0 + MARKET = market order. slice lets Upstox split
// a quantity above the exchange freeze limit into multiple orders.
// Returns the broker order id(s, comma-joined when sliced).
async function placeOrder(instrumentKey, transactionType, quantity, product = "I") {
  const body = {
    quantity,
    product,
    validity: "DAY",
    price: 0,
    instrument_token: instrumentKey,
    order_type: "MARKET",
    transaction_type: transactionType,
    disclosed_quantity: 0,
    trigger_price: 0,
    is_amo: false,
    slice: true,
    tag: "option_dashboard"
  };
  const response = await axios.post(`${ORDER_HOST}v3/order/place`, body, {
    headers: authHeaders()
  });
  // V3 responds with data.order_ids (an array — slicing can create several)
  const ids = response.data?.data?.order_ids;
  return Array.isArray(ids) ? ids.join(",") : response.data?.data?.order_id;
}

module.exports = {
  toRichSide,
  fetchMarketData,
  fetchCandles,
  fetchDailyCandles,
  fetchQuotes,
  fetchInstruments,
  fetchHoldings,
  fetchPositions,
  placeOrder
};
