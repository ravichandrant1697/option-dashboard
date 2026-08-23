/**
 * PROMPTS — interactive startup wizard for live mode: instrument, expiry,
 * strike difference, and the live-trading double opt-in.
 */
const readline = require("readline");
const { CONFIG, LOT_SIZE, RISK_REWARD } = require("./config");
const { activateHorizon } = require("./horizons");
const runtime = require("./runtime");

// Enhancement module — a deploy that misses instruments.js must not crash
// the wizard; the expiry prompt then just shows the configured default.
let autoResolveContracts = async () => {};
try {
  ({ autoResolveContracts } = require("./instruments"));
} catch {
  console.warn("⚠️ instruments.js not found — expiry/futures auto-resolution disabled");
}

// Ask one question on the terminal and resolve with the trimmed answer.
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve =>
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    })
  );
}

// Startup wizard: pick NIFTY or a Stock (Upstox instrument key), then the
// expiry date and the strike difference used to build spreads. Enter keeps
// the shown default; the expiry prompt repeats until the format is valid.
async function setupInstrument() {
  // Horizon first — it decides product (I/D), poll cadence, trend tool,
  // square-off, and the expiry the wizard should steer toward.
  const h = (await ask("Horizon? Intraday / Positional / Swing [I/p/s]: ")).toLowerCase();
  const horizon = activateHorizon(
    h.startsWith("p") ? "positional" : h.startsWith("s") ? "swing" : "intraday"
  );
  if (horizon.minEntryDTE) {
    console.log(
      `ℹ️ ${horizon.name}: pick an expiry ≥ ${horizon.minEntryDTE} days out ` +
        `(monthly contract) — nearer expiries are blocked at entry.`
    );
  }

  const choice = (await ask("Trade NIFTY or Stock? [N/s]: ")).toLowerCase();

  if (choice === "s" || choice === "stock") {
    const key = await ask("Upstox instrument key of the stock (e.g. NSE_EQ|INE002A01018): ");
    if (key) CONFIG.instrumentKey = key;
  }

  // Auto-resolve the chosen underlying's contracts BEFORE the expiry
  // prompt, so the default the prompt shows IS the nearest live expiry
  // (typing a date still overrides it). Also fills CONFIG.futuresKey for
  // the futures-buildup gate.
  await autoResolveContracts();

  // Expiry date — NIFTY has weekly expiries, stocks are monthly.
  while (true) {
    const expiry = await ask(`Expiry date YYYY-MM-DD [${CONFIG.expiryDate}]: `);
    if (!expiry) break; // keep the default
    if (/^\d{4}-\d{2}-\d{2}$/.test(expiry) && !isNaN(Date.parse(expiry))) {
      CONFIG.expiryDate = expiry;
      break;
    }
    console.log("Invalid date — use YYYY-MM-DD (e.g. 2026-08-06)");
  }

  const diff = Number(await ask(`Strike difference [${CONFIG.strikeDiff}]: `));
  if (Number.isFinite(diff) && diff > 0) CONFIG.strikeDiff = diff;

  // Live order placement is DOUBLE opt-in: LIVE_TRADING=1 in the env AND
  // a typed YES here. Anything else keeps the engine paper-only.
  if (process.env.LIVE_TRADING === "1") {
    const confirmLive = await ask("⚠️ LIVE trading requested. Type YES to place REAL orders: ");
    runtime.setLiveTrading(confirmLive === "YES");
    console.log(
      runtime.isLiveTrading() ? "🔴 LIVE ORDER MODE ENABLED" : "Live not confirmed — paper mode"
    );
  }

  console.log(
    `Instrument: ${CONFIG.instrumentKey} | Strike diff: ${CONFIG.strikeDiff} | ` +
      `Lot: ${LOT_SIZE} | RR: 1:${RISK_REWARD} | Expiry: ${CONFIG.expiryDate}`
  );
}

module.exports = { ask, setupInstrument };
