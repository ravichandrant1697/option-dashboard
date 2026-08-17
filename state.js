/**
 * STATE — the open/closed position ledger and the daily risk gates.
 * Owns positions.json: read ONCE at startup (recovery), write-only after.
 * Other modules access the ledger via getState() — never a cached copy,
 * because rollStateIfNewDay/initState replace the object.
 */
const fs = require("fs");
const { POSITIONS_FILE, RULES } = require("./config");
const { todayIST, nowIST } = require("./clock");

// In-memory position state — the live loop reads and writes ONLY this
// object; positions.json is touched once at startup (recovery) and is
// write-only afterwards.
// biasStreak = consecutive polls the CURRENT bias has held — the entry
// persistence gate (RULES.entryBiasPersistence) reads it. Persisted, so
// the 12:17 afternoon session continues the morning session's count.
let state = { date: todayIST(), open: [], closedToday: [], biasStreak: { bias: null, count: 0 } };

// Always fetch fresh — the object is REPLACED on day roll / recovery.
function getState() {
  return state;
}

// One-time startup load of positions.json into the in-memory state.
// Same day → restore as-is; older file → keep open positions, reset counters.
function initState() {
  if (!fs.existsSync(POSITIONS_FILE)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(POSITIONS_FILE, "utf8"));
    if (saved.date === state.date) state = saved;
    else state.open = saved.open || [];
  } catch {
    /* corrupt/unreadable file — start fresh */
  }
}

// If the calendar day changed while running, keep open positions but
// reset the daily risk counters (done in memory, no file read). The bias
// streak resets too — yesterday's closing bias says nothing about today's
// open, so the first entryBiasPersistence polls of a day re-confirm it.
function rollStateIfNewDay() {
  const today = todayIST();
  if (state.date !== today) {
    state = { date: today, open: state.open, closedToday: [], biasStreak: { bias: null, count: 0 } };
  }
}

// Count consecutive polls of the same bias — called by the engine exactly
// once per analysis tick, BEFORE the trade plan is built. Older
// positions.json files may lack biasStreak — default it in place.
function trackBiasStreak(bias) {
  const s = state.biasStreak ?? (state.biasStreak = { bias: null, count: 0 });
  if (s.bias === bias) s.count++;
  else { s.bias = bias; s.count = 1; }
  return s.count;
}

// Persist the in-memory state so a restart mid-session loses nothing.
function saveState() {
  fs.writeFileSync(POSITIONS_FILE, JSON.stringify(state, null, 2));
}

// Risk gatekeeper. Returns a block-reason string, or null if a new entry
// is allowed (position cap, daily loss circuit-breaker, losing streak).
function canOpen() {
  if (state.open.length >= RULES.maxOpenPositions)
    return "max open positions reached";

  const dayPnL = state.closedToday.reduce((s, t) => s + t.PnL, 0);
  if (dayPnL <= -RULES.maxDailyLoss)
    return `daily loss limit hit (₹${dayPnL.toFixed(0)})`;

  const tail = state.closedToday.slice(-RULES.maxConsecutiveLosses);
  if (
    tail.length === RULES.maxConsecutiveLosses &&
    tail.every(t => t.Result === "LOSS")
  )
    return `${RULES.maxConsecutiveLosses} losses in a row — done for today`;

  // Churn guard: wait out the cooldown after any exit before re-entering.
  // Without it the loop exits and re-enters within 1–3 polls, paying the
  // full ~₹100 round-trip charges each lap for sub-point premium moves.
  const lastExit = state.closedToday[state.closedToday.length - 1];
  if (lastExit?.ExitTime) {
    // ExitTime is an IST wall-clock string ("YYYY-MM-DD HH:mm:ss") that
    // parses as machine-local time — measure it against nowIST(), which
    // shares that representation, so the math is right on any machine.
    const sinceMs = nowIST().getTime() - new Date(lastExit.ExitTime).getTime();
    if (sinceMs >= 0 && sinceMs < RULES.reentryCooldownMs) {
      const waitMin = Math.ceil((RULES.reentryCooldownMs - sinceMs) / 60000);
      return `re-entry cooldown — ${waitMin} min left`;
    }
  }

  return null;
}

module.exports = { getState, initState, rollStateIfNewDay, saveState, canOpen, trackBiasStreak };
