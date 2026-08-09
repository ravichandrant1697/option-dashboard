/**
 * CONFIG — every constant and tunable of the option dashboard.
 *
 * All other modules read configuration from here; nothing outside this
 * file touches process.env for configuration (the DEBUG_* trace flags,
 * read at call time, are the only exception).
 */
require("dotenv").config();

const ACCESS_TOKEN = process.env.UPSTOX_TOKEN || "YOUR_ACCESS_TOKEN";
const HOST = "https://api.upstox.com/"; // main API host
const ORDER_HOST = "https://api-hft.upstox.com/"; // V3 order APIs live on the HFT host
const FILE_NAME = "option_dashboard.xlsx";   // Excel workbook (Dashboard + Trades sheets)
const POSITIONS_FILE = "positions.json";     // open-position state, survives restarts
const TUNING_FILE = "tuning.json";           // self-tuned parameters, written daily

// Runtime config — instrumentKey and strikeDiff are set by the startup
// prompts (NIFTY or Stock, and the gap between strikes for spreads).
const CONFIG = {
  instrumentKey: "NSE_INDEX|Nifty 50",
  expiryDate: "2026-08-11", // nearest expiry — update weekly (auto-pick is a V6 item)
  strikeRange: 1000,         // analyze ATM ± this many points
  strikeDiff: 50,           // spread width: sell leg = ATM ± strikeDiff (asked at startup)
  pollMs: 60000,            // poll the chain every 60 seconds
  portfolioRefreshMs: 15 * 60000, // snapshot long-term holdings every 15 min
  positionsRefreshMs: 5 * 60000,  // snapshot broker F&O positions every 5 min
  candleRefreshMs: 5 * 60000,     // refresh the 5-minute candle trend every 5 min
  wsUrl: process.env.UPSTOX_WS_URL || "" // WebSocket stream URL (optional)
};

const CAPITAL = 50000;      // trading capital in ₹
const LOT_SIZE = 65;        // contract quantity per lot

// Risk model: risk up to 10% of capital per trade. (2% = ₹1,000 can never
// cover one lot's stop distance, so nothing would ever trade.)
const RISK_PER_TRADE = 0.1;
const MAX_RISK = CAPITAL * RISK_PER_TRADE; // ₹5,000

// 1:2 risk-reward everywhere: stop = 50% of net premium,
// target distance = 2 × stop distance.
const STOP_PCT = 0.5;
const RISK_REWARD = 2;

const RULES = {
  minConfidence: 70,          // trade filter: below this → NO TRADE
  maxOpenPositions: 1,
  maxDailyLoss: MAX_RISK,     // one full-risk loss ends the day
  maxConsecutiveLosses: 3,    // 3 losses in a row → done for the day
  squareOffHour: 15,          // 15:20 IST forced exit
  squareOffMin: 20
};

// Approximate SPAN + exposure margin for one hedged credit lot (Iron
// Condor). Premium-vs-capital is NOT a valid affordability check for short
// legs — replace with your broker's margin API for real numbers.
const MARGIN_PER_CREDIT_LOT = 45000;

const TG = { token: process.env.TG_BOT_TOKEN, chatId: process.env.TG_CHAT_ID };

// Non-interactive config via env vars — used by tick mode (CI/GitHub
// Actions) where the startup prompts can't run.
function applyEnvConfig() {
  if (process.env.INSTRUMENT_KEY) CONFIG.instrumentKey = process.env.INSTRUMENT_KEY;
  if (/^\d{4}-\d{2}-\d{2}$/.test(process.env.EXPIRY_DATE || "")) {
    CONFIG.expiryDate = process.env.EXPIRY_DATE;
  }
  const diff = Number(process.env.STRIKE_DIFF);
  if (Number.isFinite(diff) && diff > 0) CONFIG.strikeDiff = diff;
}

module.exports = {
  ACCESS_TOKEN,
  HOST,
  ORDER_HOST,
  FILE_NAME,
  POSITIONS_FILE,
  TUNING_FILE,
  CONFIG,
  CAPITAL,
  LOT_SIZE,
  RISK_PER_TRADE,
  MAX_RISK,
  STOP_PCT,
  RISK_REWARD,
  RULES,
  MARGIN_PER_CREDIT_LOT,
  TG,
  applyEnvConfig
};
