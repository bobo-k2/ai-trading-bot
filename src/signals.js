/**
 * Signal detection - momentum + mean reversion strategies
 */
const config = require('../config.json');
const { writeAlert } = require('./alerts');

// ── Price history for mean reversion (in-memory rolling window) ──
// Map<mint, Array<{price, ts}>>
const priceHistory = new Map();
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h of price data
const MIN_DATAPOINTS_MR = 20; // need at least 20 data points before triggering

/**
 * Record a price tick for mean reversion analysis
 */
function recordPrice(mint, price) {
  if (!priceHistory.has(mint)) priceHistory.set(mint, []);
  const hist = priceHistory.get(mint);
  hist.push({ price, ts: Date.now() });
  // Trim old entries
  const cutoff = Date.now() - HISTORY_WINDOW_MS;
  while (hist.length > 0 && hist[0].ts < cutoff) hist.shift();
}

/**
 * Calculate mean reversion indicators from price history
 */
function getMeanReversionIndicators(mint, currentPrice) {
  const hist = priceHistory.get(mint);
  if (!hist || hist.length < MIN_DATAPOINTS_MR) return null;

  const prices = hist.map(h => h.price);
  const n = prices.length;

  // Simple Moving Average
  const sma = prices.reduce((a, b) => a + b, 0) / n;

  // Standard deviation
  const variance = prices.reduce((sum, p) => sum + (p - sma) ** 2, 0) / n;
  const stdDev = Math.sqrt(variance);

  // Bollinger Band position: how many std devs from mean
  const zScore = stdDev > 0 ? (currentPrice - sma) / stdDev : 0;

  // RSI (14-period or all available)
  const rsiPeriod = Math.min(14, n - 1);
  let gains = 0, losses = 0;
  for (let i = n - rsiPeriod; i < n; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / rsiPeriod;
  const avgLoss = losses / rsiPeriod;
  const rs = avgLoss > 0 ? avgGain / avgLoss : 100;
  const rsi = 100 - (100 / (1 + rs));

  // % deviation from SMA
  const deviationPct = ((currentPrice - sma) / sma) * 100;

  // Recent high/low for drop calculation
  const recentPrices = prices.slice(-Math.min(48, n)); // ~last 12h at 15s intervals... or less
  const recentHigh = Math.max(...recentPrices);
  const dropFromHigh = ((currentPrice - recentHigh) / recentHigh) * 100;

  return { sma, stdDev, zScore, rsi, deviationPct, dropFromHigh, dataPoints: n };
}

// ═══════════════════════════════════════════════════════════
// STRATEGY 1: MOMENTUM (existing)
// ═══════════════════════════════════════════════════════════

function analyzeMomentum(token) {
  let score = 0;
  const reasons = [];

  // 1. Volume spike: 1h volume vs 6h avg per hour
  const avg6hPerHour = (token.volume6h || 0) / 6;
  if (avg6hPerHour > 0 && token.volume1h > avg6hPerHour * config.filters.volumeSpikeMultiplier) {
    const spike = token.volume1h / avg6hPerHour;
    score += Math.min(30, spike * 10);
    reasons.push(`Volume spike ${spike.toFixed(1)}x`);
  }

  // 2. Buy pressure
  const buys = token.txns24h?.buys || 0;
  const sells = token.txns24h?.sells || 0;
  if (buys + sells > 0) {
    const buyRatio = buys / (buys + sells);
    if (buyRatio > 0.55) {
      score += Math.min(25, (buyRatio - 0.5) * 100);
      reasons.push(`Buy ratio ${(buyRatio * 100).toFixed(0)}%`);
    }
  }

  // 3. Short-term momentum
  if (token.priceChange1h > 2) {
    score += Math.min(20, token.priceChange1h * 2);
    reasons.push(`1h +${token.priceChange1h.toFixed(1)}%`);
  }

  // 4. Trend confirmation
  if (token.priceChange6h > 0 && token.priceChange24h > 0) {
    score += 10;
    reasons.push('Sustained uptrend');
  }

  // 5. High liquidity bonus
  if (token.liquidity > 5000000) {
    score += 5;
    reasons.push('High liquidity');
  }

  // 6. Breakout proxy
  if (token.priceChange1h > 5 && token.volume1h > 100000) {
    score += 10;
    reasons.push('Possible breakout');
  }

  // Negative signals
  if (token.priceChange1h < -3) { score -= 20; reasons.push('Dumping'); }
  if (sells > buys * 1.5) { score -= 15; reasons.push('Heavy selling'); }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    strategy: 'momentum',
    reasons,
    token: token.token,
    mint: token.mint,
    price: token.price
  };
}

// ═══════════════════════════════════════════════════════════
// STRATEGY 2: MEAN REVERSION
// ═══════════════════════════════════════════════════════════

/**
 * Mean reversion: buy oversold tokens expecting bounce back to mean
 *
 * Entry conditions (score >= 35):
 * - Price significantly below SMA (negative z-score)
 * - RSI oversold (<35)
 * - Recent drop from high >5%
 * - Volume present (not dead token)
 *
 * Exit: tighter TP (+8-12%) and SL (-8%) vs momentum
 */
function analyzeMeanReversion(token) {
  let score = 0;
  const reasons = [];

  // Record price for history
  recordPrice(token.mint, token.price);

  // Get mean reversion indicators
  const mr = getMeanReversionIndicators(token.mint, token.price);

  // If not enough data yet, can still use DexScreener's price changes as proxy
  if (mr) {
    // 1. Z-Score: price below mean (negative = oversold)
    if (mr.zScore < -1.5) {
      score += Math.min(30, Math.abs(mr.zScore) * 12);
      reasons.push(`Z-score ${mr.zScore.toFixed(2)} (oversold)`);
    } else if (mr.zScore < -1.0) {
      score += Math.min(15, Math.abs(mr.zScore) * 8);
      reasons.push(`Z-score ${mr.zScore.toFixed(2)}`);
    }

    // 2. RSI oversold
    if (mr.rsi < 25) {
      score += 25;
      reasons.push(`RSI ${mr.rsi.toFixed(0)} (very oversold)`);
    } else if (mr.rsi < 35) {
      score += 15;
      reasons.push(`RSI ${mr.rsi.toFixed(0)} (oversold)`);
    }

    // 3. Drop from recent high
    if (mr.dropFromHigh < -10) {
      score += 15;
      reasons.push(`${mr.dropFromHigh.toFixed(1)}% from high`);
    } else if (mr.dropFromHigh < -5) {
      score += 8;
      reasons.push(`${mr.dropFromHigh.toFixed(1)}% from high`);
    }

    // Penalty: if price is ABOVE mean, this isn't a mean reversion play
    if (mr.zScore > 0.5) {
      score -= 30;
      reasons.push('Above mean (skip)');
    }
  } else {
    // Fallback: use DexScreener price change data as proxy
    // 24h drop as oversold signal
    if (token.priceChange24h < -10) {
      score += 20;
      reasons.push(`24h ${token.priceChange24h.toFixed(1)}% (proxy oversold)`);
    } else if (token.priceChange24h < -5) {
      score += 10;
      reasons.push(`24h ${token.priceChange24h.toFixed(1)}%`);
    }

    // 6h drop
    if (token.priceChange6h < -8) {
      score += 15;
      reasons.push(`6h ${token.priceChange6h.toFixed(1)}% (sharp drop)`);
    } else if (token.priceChange6h < -4) {
      score += 8;
      reasons.push(`6h ${token.priceChange6h.toFixed(1)}%`);
    }

    // 1h showing early bounce (price recovering)
    if (token.priceChange1h > 0 && token.priceChange6h < -5) {
      score += 10;
      reasons.push(`1h +${token.priceChange1h.toFixed(1)}% (bounce starting)`);
    }
  }

  // Volume confirmation (need activity, dead tokens don't bounce)
  if (token.volume1h > 50000) {
    score += 5;
    reasons.push('Active volume');
  } else if (token.volume1h < 10000) {
    score -= 10;
    reasons.push('Low volume (risky)');
  }

  // Buy pressure starting to return
  const buys = token.txns24h?.buys || 0;
  const sells = token.txns24h?.sells || 0;
  if (buys + sells > 0) {
    const buyRatio = buys / (buys + sells);
    if (buyRatio > 0.5 && token.priceChange24h < -5) {
      score += 10;
      reasons.push(`Buyers returning (${(buyRatio * 100).toFixed(0)}%)`);
    }
  }

  // High liquidity = safer mean reversion play
  if (token.liquidity > 5000000) {
    score += 5;
    reasons.push('High liquidity');
  }

  // DANGER: if token is in freefall (1h AND 6h both deeply negative), skip
  if (token.priceChange1h < -5 && token.priceChange6h < -10) {
    score -= 25;
    reasons.push('Freefall — wait for stabilization');
  }

  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    strategy: 'meanReversion',
    reasons,
    token: token.token,
    mint: token.mint,
    price: token.price,
    indicators: mr || null
  };
}

// ═══════════════════════════════════════════════════════════
// COMBINED SIGNAL DETECTION
// ═══════════════════════════════════════════════════════════

/**
 * Run both strategies on all candidates, return best signals
 */
function detectSignals(candidates) {
  const allSignals = [];

  for (const token of candidates) {
    // Always record price for building history
    recordPrice(token.mint, token.price);

    // Run momentum
    const mom = analyzeMomentum(token);
    if (mom.score >= 35) allSignals.push(mom);

    // Run mean reversion
    const mr = analyzeMeanReversion(token);
    if (mr.score >= 35) allSignals.push(mr);
  }

  // Sort by score, deduplicate per token (keep highest scoring strategy)
  allSignals.sort((a, b) => b.score - a.score);

  const seen = new Set();
  const signals = [];
  for (const s of allSignals) {
    if (!seen.has(s.mint)) {
      seen.add(s.mint);
      signals.push(s);
    }
  }

  if (signals.length > 0) {
    writeAlert('SIGNAL', `Detected ${signals.length} signals`, {
      top: signals.slice(0, 5).map(s => ({
        token: s.token,
        score: s.score,
        strategy: s.strategy,
        reasons: s.reasons
      }))
    });
  }

  return signals;
}

/**
 * Get the number of tracked price histories
 */
function getPriceHistoryCount() {
  return priceHistory.size;
}

module.exports = { analyzeMomentum, analyzeMeanReversion, detectSignals, recordPrice, getPriceHistoryCount };
