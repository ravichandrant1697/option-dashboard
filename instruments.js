/**
 * INSTRUMENTS — startup auto-resolution of contract details from the
 * Upstox instruments master, so nothing needs weekly/monthly hand-editing:
 *
 *   CONFIG.expiryDate  nearest option expiry of the underlying (rolls to
 *                      the NEXT one on expiry day itself — intraday blocks
 *                      DTE-0 entries anyway, so anchoring the chain there
 *                      would waste the whole day)
 *   CONFIG.futuresKey  near-month FUTURES contract of the underlying —
 *                      feeds the futures-buildup confirmation gate
 *
 * Pins win over auto-resolution: a valid EXPIRY_DATE env (or the live-mode
 * wizard's typed expiry) keeps the expiry; FUTURES_KEY env keeps the
 * futures key. When both are pinned the master download is skipped.
 * Any failure is NON-FATAL: the engine keeps configured values and logs why.
 */
const { CONFIG, LOT_SIZE } = require("./config");
const { todayIST } = require("./clock");
const { fetchInstruments } = require("./upstox-api");

// Epoch-ms expiry → IST calendar date "YYYY-MM-DD" (the format CONFIG and
// clock.daysUntil work with).
function expiryToIST(ms) {
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// Pure resolver over instrument-master rows — separated from the download
// so it is testable. Returns { expiryDate, futuresKey, futuresSymbol,
// optionLotSize } (fields null when not found). "Nearest" = smallest
// expiry ≥ today; when that is TODAY and a later contract exists, the
// later one wins (expiry-day roll).
function resolveFromRows(rows, underlyingKey, today, exchange = "NSE") {
  const mine = rows.filter(
    r => r.underlying_key === underlyingKey && r.segment === exchange + "_FO"
  );

  const nearest = list => {
    const dates = [...new Set(list.map(r => expiryToIST(r.expiry)))]
      .filter(d => d >= today)
      .sort();
    if (!dates.length) return null;
    return dates[0] === today && dates[1] ? dates[1] : dates[0];
  };

  const options = mine.filter(r => r.instrument_type === "CE" || r.instrument_type === "PE");
  const futures = mine.filter(r => r.instrument_type === "FUT");

  const expiryDate = nearest(options);
  const futExpiry = nearest(futures);
  const fut = futExpiry
    ? futures.find(r => expiryToIST(r.expiry) === futExpiry)
    : null;

  return {
    expiryDate,
    futuresKey: fut?.instrument_key ?? null,
    futuresSymbol: fut?.trading_symbol ?? null,
    optionLotSize: options[0]?.lot_size ?? null
  };
}

// Startup entry point — see the header. Call AFTER env/wizard config so
// pins are visible, BEFORE the first engine tick.
async function autoResolveContracts() {
  const expiryPinned = /^\d{4}-\d{2}-\d{2}$/.test(process.env.EXPIRY_DATE || "");
  if (process.env.FUTURES_KEY) CONFIG.futuresKey = process.env.FUTURES_KEY;
  const needExpiry = !expiryPinned;
  const needFutures = !CONFIG.futuresKey;
  if (!needExpiry && !needFutures) {
    console.log("🔒 Contracts pinned by env — instruments master skipped");
    return;
  }

  // SENSEX (and any BSE_*) underlying lives on BSE — everything else NSE.
  const exchange = CONFIG.instrumentKey.startsWith("BSE") ? "BSE" : "NSE";

  try {
    console.log(`📥 Resolving contracts from the ${exchange} instruments master...`);
    const rows = await fetchInstruments(exchange);
    const r = resolveFromRows(rows, CONFIG.instrumentKey, todayIST(), exchange);

    if (needExpiry && r.expiryDate) {
      if (r.expiryDate !== CONFIG.expiryDate) {
        console.log(`📅 Expiry auto-resolved: ${CONFIG.expiryDate} → ${r.expiryDate}`);
      }
      CONFIG.expiryDate = r.expiryDate;
    } else if (needExpiry) {
      console.warn(`⚠️ No option expiry found for ${CONFIG.instrumentKey} — keeping ${CONFIG.expiryDate}`);
    }

    if (needFutures && r.futuresKey) {
      CONFIG.futuresKey = r.futuresKey;
      console.log(`📈 Futures auto-resolved: ${r.futuresSymbol} (${r.futuresKey})`);
    } else if (needFutures) {
      console.warn(`⚠️ No futures contract found for ${CONFIG.instrumentKey} — buildup gate inactive`);
    }

    // LOT_SIZE is a build-time constant used by every sizing/PnL path —
    // it cannot be swapped at runtime, so a mismatch is loudly warned, not
    // silently patched.
    if (r.optionLotSize && r.optionLotSize !== LOT_SIZE) {
      console.warn(
        `⚠️ LOT_SIZE mismatch: config ${LOT_SIZE} vs exchange ${r.optionLotSize} — fix config.js before trusting PnL`
      );
    }
  } catch (e) {
    console.error(
      "⚠️ Instruments master unavailable — keeping configured contracts:",
      e.response?.status || e.message
    );
  }
}

module.exports = { autoResolveContracts, resolveFromRows };
