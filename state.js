/**
 * STATE — the open/closed position ledger and the daily risk gates.
 * Owns positions.json: read ONCE at startup (recovery), write-only after.
 * Other modules access the ledger via getState() — never a cached copy,
 * because rollStateIfNewDay/initState replace the object.
 */
const fs = require("fs");
const { POSITIONS_FILE, RULES } = require("./config");
const { todayIST } = require("./clock");

// In-memory position state — the live loop reads and writes ONLY this
// object; positions.json is touched once at startup (recovery) and is
// write-only afterwards.
let state = { date: todayIST(), open: [], closedToday: [] };

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
// reset the daily risk counters (done in memory, no file read).
function rollStateIfNewDay() {
  const today = todayIST();
  if (state.date !== today) {
    state = { date: today, open: state.open, closedToday: [] };
  }
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

  return null;
}

module.exports = { getState, initState, rollStateIfNewDay, saveState, canOpen };
