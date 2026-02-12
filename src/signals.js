/**
 * Signal detection - volume spikes, breakouts, sentiment
 */
const config = require('../config.json');
const { writeAlert } = require('./alerts');

/**
 * Analyze a token candidate and return a signal score (0-100)
 * Higher = stronger momentum signal
 */
function analyzeSignals(token) {
  let score = 0;
  const reasons = [];

  // 1. Volume spike: 1h volume vs 6h avg per hour
  const avg6hPerHour = (token.volume6h || 0) / 6;
  if (avg6hPerHour > 0 && token.volume1h > avg6hPerHour * config.filters.volumeSpikeMultiplier) {
    const spike = token.volume1h / avg6hPerHour;
    score += Math.min(30, spike * 10);
    reasons.push(`Volume spike ${spike.toFixed(1)}x`);
  }

  // 2. Buy pressure: more buys than sells in 24h
  const buys = token.txns24h?.buys || 0;
  const sells = token.txns24h?.sells || 0;
  if (buys + sells > 0) {
    const buyRatio = buys / (buys + sells);
    if (buyRatio > 0.55) {
      score += Math.min(25, (buyRatio - 0.5) * 100);
      reasons.push(`Buy ratio ${(buyRatio * 100).toFixed(0)}%`);
    }
  }

  // 3. Short-term momentum: positive 1h price change
  if (token.priceChange1h > 2) {
    score += Math.min(20, token.priceChange1h * 2);
    reasons.push(`1h +${token.priceChange1h.toFixed(1)}%`);
  }

  // 4. Trend confirmation: 6h positive while 24h also positive (sustained)
  if (token.priceChange6h > 0 && token.priceChange24h > 0) {
    score += 10;
    reasons.push('Sustained uptrend');
  }

  // 5. High liquidity bonus (safer trade)
  if (token.liquidity > 5000000) {
    score += 5;
    reasons.push('High liquidity');
  }

  // 6. Resistance breakout proxy: 1h change > 5% with high volume
  if (token.priceChange1h > 5 && token.volume1h > 100000) {
    score += 10;
    reasons.push('Possible breakout');
  }

  // Negative signals (reduce score)
  if (token.priceChange1h < -3) {
    score -= 20;
    reasons.push('Dumping');
  }
  if (sells > buys * 1.5) {
    score -= 15;
    reasons.push('Heavy selling');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    reasons,
    token: token.token,
    mint: token.mint,
    price: token.price
  };
}

/**
 * Filter candidates down to actionable signals (score >= 50)
 */
function detectSignals(candidates) {
  const signals = candidates
    .map(analyzeSignals)
    .filter(s => s.score >= 35)
    .sort((a, b) => b.score - a.score);

  if (signals.length > 0) {
    writeAlert('SIGNAL', `Detected ${signals.length} signals`, {
      top: signals.slice(0, 5).map(s => ({ token: s.token, score: s.score, reasons: s.reasons }))
    });
  }

  return signals;
}

module.exports = { analyzeSignals, detectSignals };
