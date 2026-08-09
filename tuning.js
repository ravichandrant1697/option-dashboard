/**
 * TUNING — daily self-tuning from collected trade history. Deliberately
 * conservative: every adjustment needs a minimum sample size; with fewer
 * than 10 completed trades nothing changes.
 *
 * The exported `tuning` object keeps a STABLE reference — loadTuning
 * merges into it with Object.assign (never reassigns), so every module
 * holding the import sees updates.
 */
const fs = require("fs");
const { TUNING_FILE, RULES } = require("./config");
const { todayIST } = require("./clock");
const { SHEETS } = require("./workbook");

// Current tuned parameters. Defaults mean "no adjustment yet" — the
// engine behaves exactly like the untuned version until data justifies
// a change.
const tuning = {
  lastTuneDate: null,
  minConfidence: null,      // overrides RULES.minConfidence when set
  blockedStrategies: [],    // strategies with proven negative expectancy
  requireTrendMatch: false  // gate entries on candle-trend agreement
};

// One-time startup load of tuning.json; applies the stored confidence
// threshold immediately.
function loadTuning() {
  if (!fs.existsSync(TUNING_FILE)) return;
  try {
    Object.assign(tuning, JSON.parse(fs.readFileSync(TUNING_FILE, "utf8")));
    if (tuning.minConfidence) RULES.minConfidence = tuning.minConfidence;
    console.log(
      `🔧 Tuning loaded (${tuning.lastTuneDate}): minConf ${RULES.minConfidence}` +
        ` | blocked [${tuning.blockedStrategies.join(", ") || "none"}]` +
        `${tuning.requireTrendMatch ? " | trend-match required" : ""}`
    );
  } catch {
    /* corrupt file — keep defaults */
  }
}

// Re-tune the strategy from completed trades. Deliberately conservative:
//   1. Block a strategy only after ≥5 trades with negative expectancy.
//   2. Set the confidence threshold to the lowest band (70/80/90) whose
//      trades are profitable overall (≥5 trades in the band).
//   3. Require candle-trend agreement only when ≥5 counter-trend trades
//      lost money AND ≥5 with-trend trades made money.
// With < 10 completed trades nothing changes. Writes tuning.json and
// applies the result to the running engine immediately.
function runTuning() {
  const trades = (SHEETS.Trades || []).filter(
    t => t.Result === "WIN" || t.Result === "LOSS"
  );
  tuning.lastTuneDate = todayIST();

  if (trades.length < 10) {
    console.log(`🔧 TUNE: only ${trades.length} completed trade(s) — need 10+, keeping defaults`);
    fs.writeFileSync(TUNING_FILE, JSON.stringify(tuning, null, 2));
    return;
  }

  const expectancyOf = list =>
    list.reduce((s, t) => s + (Number(t.PnL) || 0), 0) / list.length;

  // 1) Block strategies that lose money
  const byStrategy = {};
  for (const t of trades) (byStrategy[t.Strategy] = byStrategy[t.Strategy] || []).push(t);
  tuning.blockedStrategies = Object.entries(byStrategy)
    .filter(([, list]) => list.length >= 5 && expectancyOf(list) < 0)
    .map(([name]) => name);

  // 2) Lowest confidence threshold that is profitable overall
  let minConf = null;
  for (const lo of [70, 80, 90]) {
    const subset = trades.filter(t => Number(t.Confidence) >= lo);
    if (subset.length >= 5 && expectancyOf(subset) > 0) {
      minConf = lo;
      break;
    }
  }
  if (minConf !== null) {
    tuning.minConfidence = minConf;
    RULES.minConfidence = minConf;
  } else {
    console.log(
      "🔧 TUNE: no profitable confidence band — threshold unchanged; review the strategy before trading on"
    );
  }

  // 3) Require trend agreement when counter-trend entries lose
  const matchesTrend = t =>
    (t.EntryBias === "Bullish" && t.TrendAtEntry === "Up") ||
    (t.EntryBias === "Bearish" && t.TrendAtEntry === "Down") ||
    (t.EntryBias === "Range" && t.TrendAtEntry === "Flat");
  const withTrend = trades.filter(t => t.TrendAtEntry);
  const matched = withTrend.filter(matchesTrend);
  const mismatched = withTrend.filter(t => !matchesTrend(t));
  tuning.requireTrendMatch =
    mismatched.length >= 5 &&
    expectancyOf(mismatched) < 0 &&
    matched.length >= 5 &&
    expectancyOf(matched) > 0;

  fs.writeFileSync(TUNING_FILE, JSON.stringify(tuning, null, 2));

  console.log("🔧 TUNE COMPLETE");
  console.log(`   Trades analyzed:  ${trades.length}`);
  console.log(`   Min confidence:   ${RULES.minConfidence}`);
  console.log(`   Blocked:          ${tuning.blockedStrategies.join(", ") || "none"}`);
  console.log(`   Trend-match gate: ${tuning.requireTrendMatch ? "ON" : "off"}`);
  for (const [name, list] of Object.entries(byStrategy)) {
    console.log(
      `   ${name}: n=${list.length}, expectancy ₹${expectancyOf(list).toFixed(0)}/trade`
    );
  }
}

module.exports = { tuning, loadTuning, runTuning };
