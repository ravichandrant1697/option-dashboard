/**
 * OPTIONS DASHBOARD — ENTRY POINT
 * ============================================================
 * Options signal engine + paper-trading journal for NIFTY/stock options
 * on Upstox, in THREE horizons (playbook trader types):
 *   intraday    day trader — 5-min tools, product I, 15:20 square-off
 *   positional  days → 1 month — daily 20/50 SMA, product D, TIME_STOP 30d
 *   swing       up to 3 months — daily 100/200 SMA, product D, TIME_STOP 90d
 * Select with HORIZON=positional|swing (headless) or the startup prompt
 * (live mode). Default: intraday. See ./option-dashboard/horizons.js.
 *
 * This file is only the CLI dispatcher — the code lives in
 * ./option-dashboard/, one module per responsibility:
 *
 *   config.js      every constant and tunable (capital, risk, RULES)
 *   horizons.js    intraday/positional/swing profiles + active selection
 *   clock.js       IST time, market hours, square-off window
 *   runtime.js     cross-module session state (candle trend, live ticks…)
 *   notify.js      console + Telegram alerts
 *   upstox-api.js  every Upstox HTTP call (chain, candles, orders, portfolio)
 *   signals.js     signal generator: build-up classification (FIX 1),
 *                  analyze(), bias, bias-relative confidence (FIX 2),
 *                  strategy scoring, candle trend
 *   strategies.js  the four playbook structures + leg expansion
 *   pricing.js     net-premium pricing, exit levels/decisions, lot sizing
 *   state.js       open/closed position ledger + daily risk gates
 *   tuning.js      daily self-tuning from trade history
 *   workbook.js    Excel journal (date-scoped Dashboard sheets + Trades)
 *   trade.js       plan → open → close lifecycle, live order execution
 *   stream.js      optional WebSocket ticks for instant exits (JSON relay)
 *   portfolio.js   broker holdings/positions snapshots
 *   engine.js      run() — the per-tick orchestration
 *   backtest.js    metrics over collected trades
 *   prompts.js     interactive startup wizard (live mode)
 *
 * SETUP:  npm install axios xlsx dotenv    (ws optional, for streaming)
 *
 * RUN:
 *   node option-dashboard.js             → asks NIFTY/Stock + strike diff,
 *                                          then starts the live loop
 *   node option-dashboard.js backtest    → analyze collected trades (no prompts)
 *   node option-dashboard.js tune        → re-tune strategy from trade history
 *   node option-dashboard.js session     → headless live loop for CI;
 *                                          env config, exits at SESSION_END
 *   node option-dashboard.js tick        → ONE headless cycle, then exit —
 *                                          for schedulers (GitHub Actions/cron);
 *                                          no prompts, config comes from env.
 *                                          Live orders are impossible in tick
 *                                          mode (the YES prompt never runs).
 *
 * ENV:
 *   UPSTOX_TOKEN   Upstox access token (required for live data)
 *   HORIZON        intraday (default) | positional | swing
 *   TG_BOT_TOKEN   optional — Telegram alerts
 *   TG_CHAT_ID     optional — Telegram alerts
 *   FORCE_RUN=1    optional — bypass the market-hours guard (testing)
 *   DEBUG_CHAIN=1  optional — dump the full option-chain JSON every tick
 *   DEBUG_SIGNALS=1 optional — per-strike build-up classification trace
 *   LIVE_TRADING=1 optional — enable REAL orders (also needs typed YES)
 *   UPSTOX_WS_URL  optional — JSON-relay stream URL (needs npm install ws)
 *   INSTRUMENT_KEY / EXPIRY_DATE / STRIKE_DIFF — headless config (tick mode)
 *   AUTO_EXIT=1    optional — live loop exits once the trading day ends
 *   SESSION_END    optional — "HH:MM" IST; session mode exits past this time
 *
 * FLOW (per tick): fetch chain from the API → if a response is received,
 * WRITE the data (Dashboard row) → then MAKE THE DECISION (exits, entry).
 * Files are read only ONCE at startup (history + open-position recovery);
 * every runtime decision uses live API response data, never file contents.
 */
const { CONFIG, applyEnvConfig } = require("./config");
const { istTimestamp } = require("./clock");
const { activateHorizon } = require("./horizons");
const { validateToken } = require("./upstox-api");
const { notify } = require("./notify");


const { loadWorkbookCache } = require("./workbook");
const { initState } = require("./state");
const { loadTuning, runTuning } = require("./tuning");
const { connectStream } = require("./stream");
const { run } = require("./engine");
const { runBacktest } = require("./backtest");
const { setupInstrument } = require("./prompts");

const mode = (process.argv[2] || "").toLowerCase();

console.log("======================================");
console.log("Option Dashboard Started");
console.log("Mode :", mode || "live");
console.log("Time :", istTimestamp(), "IST"); // CI machines run UTC — log IST
console.log("======================================");

if (mode === "backtest") {
  console.log(">>> Running BACKTEST mode...");
  runBacktest();

} else if (mode === "tune") {
  console.log(">>> Running TUNE mode...");
  loadWorkbookCache();
  runTuning();

} else if (mode === "session") {
  console.log(">>> Running SESSION mode...");

  (async () => {
    console.log("Loading ENV configuration...");
    applyEnvConfig();
    activateHorizon(process.env.HORIZON);

    

    console.log("Loading workbook cache...");
    loadWorkbookCache();

    console.log("Initializing state...");
    initState();

    console.log("Loading tuning...");
    loadTuning();

    console.log("Connecting WebSocket...");
    connectStream();

    console.log("Running first cycle...");
    await run();

    console.log(`Polling every ${CONFIG.pollMs / 1000} seconds...`);

    setInterval(async () => {
      console.log("--------------------------------");
      console.log("Running next cycle...");
      await run();
    }, CONFIG.pollMs);

  })();

} else if (mode === "tick") {

  console.log(">>> Running TICK mode...");

  (async () => {

    console.log("Loading ENV...");
    applyEnvConfig();
    activateHorizon(process.env.HORIZON);


    console.log("Loading workbook...");
    loadWorkbookCache();

    console.log("Initializing...");
    initState();

    console.log("Loading tuning...");
    loadTuning();

    console.log("Executing one tick...");
    await run();

    console.log("Tick completed.");
    process.exit(0);

  })();

} else {

  console.log(">>> Running LIVE mode...");

  (async () => {

    console.log("Setup instrument...");
    await setupInstrument();

    console.log("Loading workbook...");
    loadWorkbookCache();

    console.log("Initializing...");
    initState();

    console.log("Loading tuning...");
    loadTuning();

    console.log("Running first cycle...");
    await run();

    console.log(`Polling every ${CONFIG.pollMs / 1000} seconds...`);

    setInterval(async () => {
      console.log("--------------------------------");
      console.log("Running next cycle...");
      await run();
    }, CONFIG.pollMs);

  })();

}
