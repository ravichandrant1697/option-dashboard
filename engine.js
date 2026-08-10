/**
 * ENGINE — one tick of the live loop. The API response is the only data
 * source: response received → WRITE the data (Dashboard row) → MAKE THE
 * DECISION (exits first, then a possible entry). No response → no write,
 * no decision — just wait for the next tick.
 *
 * EXITS: STOP | TARGET | SIGNAL_CHANGE (bias or top strategy no longer
 * matches the open position) | SQUARE_OFF (15:20 IST).
 */
const { isMarketOpen, isSquareOffTime, pastIST, todayIST } = require("./clock");
const { fetchMarketData } = require("./upstox-api");
const { analyze, maybeRefreshCandleTrend } = require("./signals");
const { buildTradePlan, openPosition, closePosition } = require("./trade");
const { getNetPremium, checkExit } = require("./pricing");
const { getState, rollStateIfNewDay, saveState, canOpen } = require("./state");
const { appendRow, dashboardSheetName, toDashboardRow } = require("./workbook");
const { maybeRefreshPortfolio, maybeRefreshPositions } = require("./portfolio");
const { tuning, runTuning } = require("./tuning");
const { getActiveHorizon } = require("./horizons");
const runtime = require("./runtime");

async function run() {
  console.log("\n==================================================");
  console.log("RUN START:", new Date().toLocaleString());
  console.log("==================================================");

  try {

    console.log("Checking market status...");

    if (process.env.AUTO_EXIT === "1" && !isMarketOpen() && isSquareOffTime()) {
      console.log("Market closed — AUTO_EXIT");
      process.exit(0);
    }

    if (process.env.SESSION_END && pastIST(process.env.SESSION_END)) {
      console.log(`SESSION_END ${process.env.SESSION_END} IST reached — exiting`);
      process.exit(0);
    }

    if (!isMarketOpen() && !process.env.FORCE_RUN) {
      console.log("Market closed. Tick skipped.");
      return;
    }

    console.log("Market Open: Proceeding...");

    // ====================================================
    // FETCH DATA
    // ====================================================

    let chain, marketPcr;

    try {
      console.log("Calling fetchMarketData()...");

      ({ chain, marketPcr } = await fetchMarketData());

      console.log("fetchMarketData() SUCCESS");
      console.log("Market PCR:", marketPcr);
      console.log("Chain Length:", chain?.length || 0);

      if (chain?.length) {
        console.log("Sample Strike:", chain[0].strike_price);
      }

    } catch (e) {

      console.error("fetchMarketData FAILED");

      if (e.response) {
        console.error("Status:", e.response.status);
        console.error("Response:", JSON.stringify(e.response.data, null, 2));
      } else {
        console.error("Error:", e.message);
      }

      return;
    }

    
    if (!chain || !chain.length) {
      console.error("Empty option chain — skipping tick");
      return;
    }

    // ====================================================
    // CANDLE REFRESH  (interval-gated inside)
    // ====================================================

    console.log("Checking candle refresh...");
    await maybeRefreshCandleTrend();

    // ====================================================
    // ANALYSIS
    // ====================================================

    console.log("Running analysis...");

    const result = analyze(chain, marketPcr);

    console.log("Analysis completed.");
    console.log("Bias:", result.bias);
    console.log("Confidence:", result.confidence);
    console.log("Spot:", result.spot);

    runtime.setLastResult(result); // the stream exit sweep reuses this

    // ====================================================
    // TRADE PLAN
    // ====================================================

    console.log("Building trade plan...");

    const plan = buildTradePlan(result, chain);

    console.log(
      "Trade Plan:",
      plan
        ? `${plan.rec.strategy} | Lots=${plan.lots}`
        : "NO TRADE"
    );

    appendRow(
      dashboardSheetName(),
      toDashboardRow(result, plan)
    );

    console.log("Dashboard row written.");

    // ====================================================
    // POSITION MANAGEMENT  (exits BEFORE any new entry)
    // ====================================================

    rollStateIfNewDay();

    const state = getState();

    console.log("Open Positions:", state.open.length);

    for (const pos of [...state.open]) {

      console.log("Checking position:", pos.id);

      const netNow = getNetPremium(chain, pos.legs);

      if (netNow === null) {
        console.log("Strike not found. Skipping.");
        continue;
      }

      const exit = checkExit(pos, netNow, result);

      if (exit) {

        console.log(
          `EXIT SIGNAL -> ${exit.reason} | ${exit.outcome}`
        );

        await closePosition(
          pos,
          netNow,
          exit.outcome,
          exit.reason
        );
      }
    }

    // ====================================================
    // ENTRY CHECK
    // ====================================================

    // The 15:20 no-new-entries cutoff applies to the intraday horizon
    // only — positional/swing positions are MEANT to be held overnight.
    if (plan && plan.lots >= 1 && (!getActiveHorizon().squareOff || !isSquareOffTime())) {

      console.log("Checking entry conditions...");

      const blocked = canOpen();

      if (blocked) {
        console.log("Entry blocked:", blocked);
      } else {
        console.log("Opening position...");
        await openPosition(result, plan);
      }

    } else if (plan && plan.lots < 1) {

      console.log(
        `Skipped ${plan.rec.strategy}: risk/cost exceeds limits`
      );
    }

    saveState();

    console.log("State saved.");

    // ====================================================
    // REFRESHES  (interval-gated inside)
    // ====================================================

    await maybeRefreshPositions();
    await maybeRefreshPortfolio();

    // ====================================================
    // DAILY TUNING
    // ====================================================

    if (
      isSquareOffTime() &&
      !getState().open.length &&
      tuning.lastTuneDate !== todayIST()
    ) {
      console.log("Running daily tuning...");
      runTuning();
    }

    console.log("RUN COMPLETED SUCCESSFULLY");

  } catch (e) {

    console.error("RUN FAILED");

    if (e.response) {
      console.error("Status:", e.response.status);
      console.error(JSON.stringify(e.response.data, null, 2));
    } else {
      console.error(e.stack || e.message);
    }
  }

  console.log("==================================================");
  console.log("RUN END");
  console.log("==================================================");
}

module.exports = { run };
