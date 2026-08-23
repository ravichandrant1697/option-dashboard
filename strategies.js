/**
 * STRATEGIES — the four playbook structures and their leg expansion.
 * Pure functions: strike numbers in, legs out. Pricing/sizing lives in
 * pricing.js; scoring lives in signals.js.
 *
 * Playbook mapping (Hedging & Strategy Techniques table):
 *   #8  Bull Call Spread = ATM Call Buy + OTM Call Sell
 *   #11 Bear Put Spread  = ATM Put Buy  + OTM Put Sell
 *   #21 Condor           = OTM sells hedged by outer OTM buys
 *   #2  Long Straddle    = ATM Call Buy + ATM Put Buy
 *   #1  Buy Call         = ATM Call Buy (naked, uncapped upside)
 *   #1  Buy Put          = ATM Put Buy  (naked, uncapped downside)
 */
const { CONFIG } = require("./config");

// Bullish debit spread: buy ATM call, sell a call strikeDiff higher.
function buildBullCallSpread(atmStrike) {
  return { strategy: "Bull Call Spread", buy: atmStrike, sell: atmStrike + CONFIG.strikeDiff };
}

// Bearish debit spread: buy ATM put, sell a put strikeDiff lower.
function buildBearPutSpread(atmStrike) {
  return { strategy: "Bear Put Spread", buy: atmStrike, sell: atmStrike - CONFIG.strikeDiff };
}

// Range-bound credit structure: sell strangle at ±strikeDiff, hedge with
// wings at ±2×strikeDiff.
function buildIronCondor(atmStrike) {
  return {
    strategy: "Iron Condor",
    sellPE: atmStrike - CONFIG.strikeDiff,
    buyPE: atmStrike - CONFIG.strikeDiff * 2,
    sellCE: atmStrike + CONFIG.strikeDiff,
    buyCE: atmStrike + CONFIG.strikeDiff * 2
  };
}

// Volatility play: buy ATM call + ATM put together.
function buildLongStraddle(atmStrike) {
  return { strategy: "Long Straddle", buy: atmStrike };
}

// Naked directional bet: buy ATM call only. Uncapped upside, premium at
// risk, no short leg to offset theta decay.
function buildBuyCall(atmStrike) {
  return { strategy: "Buy Call", buy: atmStrike };
}

// Naked directional bet: buy ATM put only. Uncapped downside (to zero),
// premium at risk, no short leg to offset theta decay.
function buildBuyPut(atmStrike) {
  return { strategy: "Buy Put", buy: atmStrike };
}

// Map the top-scored strategy name to its concrete builder.
function recommend(topStrategy, atmStrike) {
  switch (topStrategy) {
    case "Bull Call Spread": return buildBullCallSpread(atmStrike);
    case "Bear Put Spread":  return buildBearPutSpread(atmStrike);
    case "Iron Condor":      return buildIronCondor(atmStrike);
    case "Long Straddle":    return buildLongStraddle(atmStrike);
    case "Buy Call":         return buildBuyCall(atmStrike);
    case "Buy Put":          return buildBuyPut(atmStrike);
  }
  return null;
}

// Expand a recommendation into concrete legs (strike + CE/PE + BUY/SELL)
// so the engine can price the whole structure from the chain.
function toLegs(rec) {
  switch (rec.strategy) {
    case "Bull Call Spread":
      return [
        { strike: rec.buy, type: "CE", side: "BUY" },
        { strike: rec.sell, type: "CE", side: "SELL" }
      ];
    case "Bear Put Spread":
      return [
        { strike: rec.buy, type: "PE", side: "BUY" },
        { strike: rec.sell, type: "PE", side: "SELL" }
      ];
    case "Iron Condor":
      return [
        { strike: rec.sellPE, type: "PE", side: "SELL" },
        { strike: rec.buyPE, type: "PE", side: "BUY" },
        { strike: rec.sellCE, type: "CE", side: "SELL" },
        { strike: rec.buyCE, type: "CE", side: "BUY" }
      ];
    case "Long Straddle":
      return [
        { strike: rec.buy, type: "CE", side: "BUY" },
        { strike: rec.buy, type: "PE", side: "BUY" }
      ];
    case "Buy Call":
      return [
        { strike: rec.buy, type: "CE", side: "BUY" }
      ];
    case "Buy Put":
      return [
        { strike: rec.buy, type: "PE", side: "BUY" }
      ];
  }
  return [];
}

module.exports = {
  buildBullCallSpread,
  buildBearPutSpread,
  buildIronCondor,
  buildLongStraddle,
  buildBuyCall,
  buildBuyPut,
  recommend,
  toLegs
};
