/**
 * PORTFOLIO — periodic snapshots of REAL broker data into the workbook:
 * long-term demat holdings ("Portfolio" sheet) and live F&O positions
 * ("Positions" sheet). Informational only — neither feeds the options
 * risk engine; a failed fetch skips the snapshot.
 */
const { CONFIG } = require("./config");
const { fetchHoldings, fetchPositions } = require("./upstox-api");
const { SHEETS, flushWorkbook } = require("./workbook");

// When each snapshot last ran (0 = never this session).
let lastPortfolioRefresh = 0;
let lastPositionsRefresh = 0;

// Snapshot holdings into the "Portfolio" sheet (one timestamped row per
// holding) and log the totals.
async function refreshPortfolio() {
  lastPortfolioRefresh = Date.now();

  let holdings;
  try {
    holdings = await fetchHoldings();
  } catch (e) {
    console.error("Portfolio fetch failed — skipping snapshot:", e.response?.data || e.message);
    return;
  }
  if (!holdings.length) {
    console.log("📁 PORTFOLIO: no long-term holdings");
    return;
  }

  const ts = new Date().toISOString();
  let invested = 0;
  let current = 0;
  let totalPnl = 0;
  let dayChange = 0;

  for (const h of holdings) {
    invested += (h.average_price || 0) * (h.quantity || 0);
    current += (h.last_price || 0) * (h.quantity || 0);
    totalPnl += h.pnl || 0;
    dayChange += h.day_change || 0;

    SHEETS.Portfolio.push({
      Timestamp: ts,
      Symbol: h.trading_symbol,
      Quantity: h.quantity,
      AvgPrice: h.average_price,
      LastPrice: h.last_price,
      PnL: h.pnl,
      DayChange: h.day_change
    });
  }
  flushWorkbook();

  console.log(
    `📁 PORTFOLIO ${holdings.length} holding(s) | Invested ₹${invested.toFixed(0)} | ` +
      `Value ₹${current.toFixed(0)} | PnL ₹${totalPnl.toFixed(0)} | Day ₹${dayChange.toFixed(0)}`
  );
}

// Snapshot the REAL broker positions into the "Positions" sheet (one
// timestamped row per position) and log total PnL. These are actual
// broker fills — useful to compare against this engine's paper trades.
async function refreshPositions() {
  lastPositionsRefresh = Date.now();

  let positions;
  try {
    positions = await fetchPositions();
  } catch (e) {
    console.error("Positions fetch failed — skipping snapshot:", e.response?.data || e.message);
    return;
  }
  if (!positions.length) {
    console.log("📊 POSITIONS: no open broker positions");
    return;
  }

  const ts = new Date().toISOString();
  let totalPnl = 0;

  for (const p of positions) {
    totalPnl += p.pnl || 0;

    SHEETS.Positions.push({
      Timestamp: ts,
      Symbol: p.trading_symbol,
      Product: p.product, // I = intraday, D = delivery/carry-forward
      Quantity: p.quantity,
      BuyPrice: p.buy_price,
      LastPrice: p.last_price,
      PnL: p.pnl
    });
  }
  flushWorkbook();

  console.log(
    `📊 POSITIONS ${positions.length} open | Total PnL ₹${totalPnl.toFixed(0)}`
  );
}

// Interval-gated wrappers — the engine calls these every tick; the
// fetches only happen on their configured cadence.
async function maybeRefreshPortfolio() {
  if (Date.now() - lastPortfolioRefresh < CONFIG.portfolioRefreshMs) return;
  console.log("Refreshing portfolio...");
  await refreshPortfolio();
}

async function maybeRefreshPositions() {
  if (Date.now() - lastPositionsRefresh < CONFIG.positionsRefreshMs) return;
  console.log("Refreshing positions...");
  await refreshPositions();
}

module.exports = {
  refreshPortfolio,
  refreshPositions,
  maybeRefreshPortfolio,
  maybeRefreshPositions
};
