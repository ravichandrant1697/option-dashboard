/**
 * ENGINE — one tick of the live loop. The API response is the only data
 * source: response received → WRITE the data (Dashboard row) → MAKE THE
 * DECISION (exits first, then a possible entry). No response → no write,
 * no decision — just wait for the next tick.
 *
 * EXITS: STOP | TARGET | SIGNAL_CHANGE (bias or top strategy no longer
 * matches the open position) | SQUARE_OFF (15:20 IST).
 */
const { isMarketOpen, isSquareOffTime, pastIST, todayIST, istTimestamp } = require("./clock");
const { fetchMarketData, fetchQuotes } = require("./upstox-api");
const { analyze, maybeRefreshCandleTrend, updateFuturesBuildup } = require("./signals");
const { buildTradePlan, openPosition, closePosition } = require("./trade");
const { getNetPremium, checkExit } = require("./pricing");
const { getState, rollStateIfNewDay, saveState, canOpen, trackBiasStreak, trackDayOpen } = require("./state");
const { appendRow, dashboardSheetName, toDashboardRow } = require("./workbook");
const { maybeRefreshPortfolio, maybeRefreshPositions } = require("./portfolio");
const { tuning, runTuning } = require("./tuning");
const { getActiveHorizon } = require("./horizons");
const { CONFIG } = require("./config");
const runtime = require("./runtime");

async function run() {
  console.log("\n==================================================");
  console.log("RUN START:", istTimestamp(), "IST"); // CI machines run UTC — log IST
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
    // FUTURES BUILD-UP  (confirmation gate input — before
    // analyze() so the poll's snapshot includes it)
    // ====================================================

    if (CONFIG.futuresKey) {
      try {
        const quotes = await fetchQuotes([CONFIG.futuresKey]);
        updateFuturesBuildup(quotes.get(CONFIG.futuresKey));
      } catch (e) {
        // keep the previous read — a dropped quote must not fabricate one
        console.error("Futures quote failed:", e.response?.status || e.message);
      }
    }

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

    // Roll the day BEFORE the plan is built: the same-legs and entry-
    // persistence gates read state and must see TODAY's, not yesterday's
    // (the first poll of a morning session used to compare same-legs
    // against the PREVIOUS day's closedToday). Then count this poll
    // toward the bias streak the persistence gate checks, and anchor the
    // day-open spot the alignment gate compares entries against.
    rollStateIfNewDay();
    trackBiasStreak(result.bias);
    trackDayOpen(result.spot);

    // ====================================================
    // TRADE PLAN
    // ====================================================

    console.log("Building trade plan...");

    const plan = await buildTradePlan(result, chain);

    console.log(
      "Trade Plan:",
      plan
        ? `${plan.rec.strategy} | Lots=${plan.lots}${plan.blocked ? ` | ENTRY BLOCKED: ${plan.blocked}` : ""}`
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
    // plan.blocked = signal logged but an execution gate (DTE/theta/
    // same-legs/cost floor) refused the trade — see buildTradePlan.
    if (plan && !plan.blocked && plan.lots >= 1 && (!getActiveHorizon().squareOff || !isSquareOffTime())) {

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


// FAST EXIT CHECK — the between-poll exit guard. ENTRIES need the whole
// chain and fresh OI (Upstox refreshes those on a 3-min cadence, so
// polling faster just re-reads stale OI), but EXITS only need the legs'
// prices: one quote call, and only while a position is actually open.
//
// This is what makes STOP / TARGET / PROFIT_LOCK behave as designed. With
// 3-minute vision a scalp can spike past its lock and round-trip back
// inside a single poll gap, unseen — the first 36 journal trades contain
// zero PROFIT_LOCK exits and exactly one TARGET.
//
// The signal-change branch reuses the LAST poll's analysis: checkExit
// counts a miss once per result.timestamp, so repeated fast checks
// against the same analysis cannot inflate the streak. closingIds guards
// the poll/fast-check race the same way it guards the stream sweep.
async function fastExitCheck() {
  const state = getState();
  if (!state.open.length) return;                 // nothing to guard
  if (!isMarketOpen() && !process.env.FORCE_RUN) return;
  const lastResult = runtime.getLastResult();
  if (!lastResult) return;                        // no analysis yet this session

  for (const pos of [...state.open]) {
    if (runtime.closingIds.has(pos.id)) continue;

    const keys = pos.legs.map(l => l.instrument_key).filter(Boolean);
    if (keys.length !== pos.legs.length) continue; // unpriceable — the poll handles it

    let quotes;
    try {
      quotes = await fetchQuotes(keys);
    } catch (e) {
      console.error("Fast exit check — quote failed:", e.response?.status || e.message);
      return;                                      // retry on the next tick
    }

    let netNow = 0;
    let complete = true;
    for (const leg of pos.legs) {
      const ltp = quotes.get(leg.instrument_key)?.last_price;
      if (ltp == null) { complete = false; break; }
      netNow += leg.side === "BUY" ? ltp : -ltp;
    }
    if (!complete) continue;

    const exit = checkExit(pos, netNow, lastResult);
    if (exit) {
      console.log(`⚡ FAST EXIT -> ${exit.reason} | ${exit.outcome} | net ${netNow.toFixed(2)}`);
      await closePosition(pos, netNow, exit.outcome, exit.reason);
      saveState();
    }
  }
}

module.exports = { run, fastExitCheck };
