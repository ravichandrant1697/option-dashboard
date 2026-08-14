/**
 * CLOCK — every IST time question in one place (market hours, square-off,
 * day boundaries). No other module computes wall-clock time itself.
 */
const { RULES } = require("./config");

// Current wall-clock time in India, regardless of the machine's timezone.
function nowIST() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
}

// Today's date in IST as YYYY-MM-DD (used to reset daily risk counters).
function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// Current IST wall-clock as "YYYY-MM-DD HH:mm:ss" — the ONLY format
// written to the Excel sheets (Timestamp/ExitTime columns) and to logs.
// UTC ISO strings made the journal look mis-scheduled ("03:45:38Z" is a
// correct 09:15 IST market open). Sortable, and keeps the YYYY-MM-DD
// prefix the backtester slices for day/month grouping. NOTE: strings in
// this format parse as MACHINE-LOCAL time — compare them against
// nowIST(), never against new Date()/Date.now().
function istTimestamp() {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" });
}

// True during NSE cash/derivatives hours: Mon–Fri 09:15–15:30 IST.
function isMarketOpen() {
  const d = nowIST();
  const day = d.getDay();
  if (day === 0 || day === 6) return false;
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= 9 * 60 + 15 && mins <= 15 * 60 + 30;
}

// True once the forced end-of-day exit window (15:20 IST) has started.
function isSquareOffTime() {
  const d = nowIST();
  const mins = d.getHours() * 60 + d.getMinutes();
  return mins >= RULES.squareOffHour * 60 + RULES.squareOffMin;
}

// True once the IST clock passes "HH:MM" — used by SESSION_END so a CI
// session job hands over cleanly to the next scheduled one.
function pastIST(hhmm) {
  const [h, m] = String(hhmm).split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  const d = nowIST();
  return d.getHours() * 60 + d.getMinutes() >= h * 60 + m;
}

// Whole calendar days from today (IST) until dateStr ("YYYY-MM-DD").
// Negative = already past. Used by the multi-day horizons for the
// days-to-expiry (DTE) entry gate and the EXPIRY_STOP exit.
function daysUntil(dateStr) {
  const ms =
    new Date(`${dateStr}T00:00:00`) - new Date(`${todayIST()}T00:00:00`);
  return Math.round(ms / 86400000);
}

module.exports = {
  nowIST,
  todayIST,
  istTimestamp,
  isMarketOpen,
  isSquareOffTime,
  pastIST,
  daysUntil
};
