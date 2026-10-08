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
const { getNetPremium, checkExit, exitLevels } = require("./pricing");
const { getState, rollStateIfNewDay, saveState, canOpen, trackBiasStreak, trackDayOpen, trackDayExtremes } = require("./state");
const stream = require("./stream"); // 2026-10-07: V3 protobuf feed — tick-level exits between polls
const { appendRow, dashboardSheetName, toDashboardRow } = require("./workbook");
const { maybeRefreshPortfolio, maybeRefreshPositions } = require("./portfolio");
const { tuning, runTuning } = require("./tuning");
const { getActiveHorizon } = require("./horizons");
const { CONFIG, RULES } = require("./config");
const runtime = require("./runtime");
// Tick journal (2026-10-07) — optional; absent module = no events written.
let ticklog = null;
try { ticklog = require("./ticklog"); } catch { /* journal off */ }
const logEvent = (type, detail) => { if (ticklog) ticklog.logEvent(type, detail); };
// Stream-fed market data (2026-10-07) — optional; absent module = REST only.
let streamfeed = null;
try { streamfeed = require("./streamfeed"); } catch { /* REST path */ }
const streamAnalysisOn = () => !!streamfeed && RULES.streamAnalysis && process.env.STREAM_ANALYSIS !== "0";

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
    let dataSource = "rest";

    // Stream-fed chain (2026-10-07): when the socket's index tick is fresh
    // and the REST seed is young enough, the live copy of the chain —
    // updated tick by tick — is the data; REST is called only to (re)seed
    // (startup, every RULES.streamReseedMs) or when the stream is stale.
    if (streamAnalysisOn() && streamfeed.chainFresh() && !streamfeed.needsReseed()) {
      chain = streamfeed.liveChain();
      marketPcr = null;
      dataSource = "stream";
      const st = streamfeed.status();
      console.log(`Live chain from the stream: ${chain.length} strikes, ${st.updatedKeys} keys tick-updated, index tick ${st.indexAgeS}s old, seed ${Math.round(st.seedAgeS / 60)} min old`);
    } else {
      try {
        console.log(streamAnalysisOn() ? `Calling fetchMarketData() (${streamfeed.needsReseed() ? "stream seed/reseed" : "stream stale — REST fallback"})...` : "Calling fetchMarketData()...");

        ({ chain, marketPcr } = await fetchMarketData());

        console.log("fetchMarketData() SUCCESS");
        console.log("Market PCR:", marketPcr);
        console.log("Chain Length:", chain?.length || 0);

        if (chain?.length) {
          console.log("Sample Strike:", chain[0].strike_price);
        }

        if (streamAnalysisOn() && chain?.length) streamfeed.seedChain(chain);

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
      // Stream-fed: the futures tick (ltp, oi) with the day open pinned by
      // the last REST quote — no call. REST cycles still quote once so the
      // day open is the exchange's, not the first tick the socket saw.
      const streamQuote = dataSource === "stream" ? streamfeed.futuresQuote() : null;
      if (streamQuote) {
        updateFuturesBuildup(streamQuote);
      } else {
        try {
          const quotes = await fetchQuotes([CONFIG.futuresKey]);
          const q = quotes.get(CONFIG.futuresKey);
          if (streamAnalysisOn()) streamfeed.seedFuturesOpen(q);
          updateFuturesBuildup(q);
        } catch (e) {
          // keep the previous read — a dropped quote must not fabricate one
          console.error("Futures quote failed:", e.response?.status || e.message);
        }
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
    runtime.setLastChain(chain);   // tick entries re-plan on this chain with the live spot

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

    // Stream the plan's legs (rotated each poll) so a position opened from
    // this plan has live ticks from its first second; open positions' legs
    // are subscribed by trade.openPosition and never dropped here.
    stream.syncPlanKeys((plan?.legs || []).map(l => l.instrument_key));

    // Streamed strike window: with the stream-fed analysis on, the whole
    // analysis window (ATM ± strikeRange, CE + PE) streams so the live
    // chain stays current; otherwise just ATM ± tickJournalStrikes for the
    // tick journal (so a replay has the strikes the bot could have chosen).
    if (Number.isFinite(result.atmStrike) && (streamAnalysisOn() || RULES.tickJournal !== false)) {
      const span = streamAnalysisOn() ? CONFIG.strikeRange : (RULES.tickJournalStrikes ?? 2) * CONFIG.strikeDiff;
      const keys = chain
        .filter(r => Math.abs(r.strike_price - result.atmStrike) <= span)
        .flatMap(r => [r.call_options?.instrument_key, r.put_options?.instrument_key])
        .filter(Boolean);
      stream.syncJournalKeys(keys);
    }
    logEvent("poll", {
      source: dataSource,
      spot: result.spot, bias: result.bias, confidence: result.confidence, atm: result.atmStrike,
      trend: runtime.getCandleTrend(), vwap: runtime.getVwap(), vwapRef: runtime.getVwapRef(), volSurge: runtime.getVolumeSurge(),
      futures: runtime.getFuturesBuildup()?.label ?? null,
      plan: plan ? { strategy: plan.rec?.strategy, legs: (plan.legs || []).map(l => `${l.side} ${l.strike}${l.type}`).join(" | "), netEntry: plan.netEntry, lots: plan.lots, blocked: plan.blocked ?? null } : null,
      open: getState().open.length
    });

    // AFTER the plan: the day-extreme retest gate must compare this poll's
    // spot against the PREVIOUS polls' low/high, never against itself.
    trackDayExtremes(result.spot);

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
      } else if (runtime.isEntryInFlight()) {
        console.log("Entry skipped: a tick entry is in flight");
      } else {
        console.log("Opening position...");
        runtime.setEntryInFlight(true);
        try { await openPosition(result, plan); } finally { runtime.setEntryInFlight(false); }
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
    // Live ticks for every leg → the stream sweep owns this position's exits
    // (tick-level, with the 5-s PROFIT_LOCK confirmation); this 5-s quote
    // check stands down rather than pre-empting the confirmation window.
    // Ticks stale or socket down → it takes over again, unchanged.
    if (stream.hasFreshTicks(pos.legs)) continue;

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

// TICK ENTRY — "no wait" (2026-10-07). Entries used to exist only on the
// 3-min chain poll, so a break that happened at 13:09:30 was bought at the
// 13:12 poll — after the premium had already spiked (166) and come back
// (144). With the stream connected, every spot tick of the underlying
// re-runs the SAME trade plan the poll would build (same bias, same chain,
// same gates — fresh break, chase checks, window, VWAP, volume, cost
// floor …), with the tick as the spot, and opens the position the moment
// it passes. The legs are re-priced from their live ticks when all of them
// are fresh, so the journal shows the real entry premium, not the chain's
// 3-min-old one. Nothing here touches the sheet row cadence or the OI
// signal: the bias still comes from the last poll.
//
// Cheap by construction: no API call unless every gate has passed (the
// depth gate inside buildTradePlan fetches bid/ask only then), state-only
// canOpen checks run first, re-plans are throttled (tickEntryMinGapMs) and
// skipped while the spot is unchanged. One entry path at a time: the
// entryInFlight lock is shared with the poll's entry branch. Block reasons
// are logged only when they change, so the log stays readable.
let lastTickEntryAt = 0;
let lastTickEntrySpot = null;
let lastTickBlock = null;
async function tickEntryCheck() {
  if (!RULES.tickEntry) return;
  const now = Date.now();
  if (now - lastTickEntryAt < (RULES.tickEntryMinGapMs || 2000)) return;
  const state = getState();
  if (state.open.length || runtime.isEntryInFlight()) return;
  if (!isMarketOpen() && !process.env.FORCE_RUN) return;
  if (getActiveHorizon().squareOff && isSquareOffTime()) return;
  const result = runtime.getLastResult(), chain = runtime.getLastChain();
  if (!result || !chain || (result.bias !== "Bullish" && result.bias !== "Bearish")) return;
  const tick = runtime.liveTicks.get(CONFIG.instrumentKey);
  if (!tick || tick.ltp == null || now - tick.at > 15000) return;
  if (tick.ltp === lastTickEntrySpot) return;               // nothing new to evaluate
  lastTickEntryAt = now; lastTickEntrySpot = tick.ltp;
  if (canOpen()) return;                                     // cooldown / max trades / daily loss — state only, no plan needed

  const res = { ...result, spot: tick.ltp };
  const plan = await buildTradePlan(res, chain);
  const block = !plan ? "no plan" : plan.blocked ? plan.blocked : plan.lots < 1 ? "lots < 1" : null;
  if (block) {
    if (block !== lastTickBlock) {
      console.log(`⚡ tick entry (spot ${tick.ltp}): ${block}`);
      logEvent("tick_gate", { spot: tick.ltp, bias: result.bias, block });
      lastTickBlock = block;
    }
    return;
  }
  lastTickBlock = null;
  // Live entry premium: every leg has a fresh tick → use it (and re-derive
  // the stop / target / lock ladder from it); otherwise keep the chain price.
  if (stream.hasFreshTicks(plan.legs)) {
    const net = stream.netFromTicks(plan.legs);
    if (net != null && net > 0) Object.assign(plan, { netEntry: net }, exitLevels(net, plan.exitMode, plan.legs.length === 1));
  }
  if (runtime.isEntryInFlight() || getState().open.length) return; // the poll got there first
  runtime.setEntryInFlight(true);
  try {
    console.log(`⚡ TICK ENTRY — spot ${tick.ltp} passed every gate between polls (bias ${result.bias} from the ${result.timestamp} poll)`);
    logEvent("tick_entry", { spot: tick.ltp, bias: result.bias, poll: result.timestamp, legs: plan.legs.map(l => `${l.side} ${l.strike}${l.type}`).join(" | "), netEntry: plan.netEntry, tickPriced: stream.hasFreshTicks(plan.legs) });
    await openPosition(res, plan);
    saveState();
  } finally {
    runtime.setEntryInFlight(false);
  }
}

// STREAM ANALYSIS — between grid cycles (2026-10-07). Re-runs analyze() on
// the live chain every RULES.streamAnalysisMs so the bias/confidence the
// tick entries read is as fresh as the exchange's latest OI publication,
// instead of up to 3 minutes old. Only lastResult/lastChain change here:
// the Dashboard row, the bias streak and the day-extreme bookkeeping stay
// on the 3-min grid (their semantics assume 3-min polls). analyze() is
// chatty, so its console output is muted for these runs; a bias change
// is logged once (and journaled) when it happens.
let lastStreamAnalysisAt = 0;
let lastStreamBias = null;
async function streamAnalyze() {
  if (!streamAnalysisOn()) return;
  const now = Date.now();
  if (now - lastStreamAnalysisAt < (RULES.streamAnalysisMs || 5000)) return;
  if (!isMarketOpen() && !process.env.FORCE_RUN) return;
  if (!streamfeed.chainFresh()) return;
  const prev = runtime.getLastResult();
  if (!prev) return; // the first grid cycle seeds everything
  lastStreamAnalysisAt = now;
  const chain = streamfeed.liveChain();
  const origLog = console.log;
  let result;
  console.log = () => {};
  try { result = analyze(chain, null); } finally { console.log = origLog; }
  if (!result) return;
  runtime.setLastResult(result);
  runtime.setLastChain(chain);
  if (lastStreamBias == null) lastStreamBias = prev.bias;
  if (result.bias !== lastStreamBias) {
    console.log(`⚡ stream analysis: bias ${lastStreamBias} → ${result.bias} (conf ${result.confidence}) at spot ${result.spot}${lastGridAt ? ` — ${Math.round((now - lastGridAt) / 1000)}s after the last grid cycle` : ""}`);
    logEvent("stream_bias", { from: lastStreamBias, to: result.bias, confidence: result.confidence, spot: result.spot, atm: result.atmStrike });
    lastStreamBias = result.bias;
  }
}
let lastGridAt = 0;
const _run = run;
// Wrap run() so the stream analysis knows when the last grid cycle was and
// keeps its bias trail in step with the grid's.
async function runWrapped() {
  await _run();
  lastGridAt = Date.now();
  lastStreamBias = runtime.getLastResult()?.bias ?? lastStreamBias;
}

module.exports = { run: runWrapped, fastExitCheck, tickEntryCheck, streamAnalyze };
