/**
 * Trend detection filter - determines market direction using SMA
 *
 * Used to decide whether to allow long entries or open shorts instead.
 * Uptrend → longs OK, Downtrend → skip longs, open shorts
 */
const { safeFetch } = require('./utils');
const { writeAlert } = require('./alerts');

// Cache trend result for 5 minutes to avoid API spam
let cachedTrend = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

// Rolling price history for SMA calculation
const priceHistory = [];
const MAX_HISTORY = 7 * 24; // 7 days of hourly data points

/**
 * Fetch SOL price history from DexScreener or CoinGecko
 * Returns array of prices (oldest first)
 */
async function fetchPriceHistory() {
  try {
    // Try CoinGecko for 7-day hourly data (free, no key needed)
    const url = 'https://api.coingecko.com/api/v3/coins/solana/market_chart?vs_currency=usd&days=7';
    const data = await safeFetch(url, {}, 15000);

    if (data && data.prices && data.prices.length > 0) {
      return data.prices.map(p => p[1]); // [timestamp, price] -> price
    }
  } catch (err) {
    console.log(`[TREND] CoinGecko failed: ${err.message}, trying fallback...`);
  }

  try {
    // Fallback: DexScreener SOL/USDC pair for current price + use rolling history
    const url = 'https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112';
    const data = await safeFetch(url, {}, 10000);

    if (data && data.pairs && data.pairs.length > 0) {
      // Find a high-liquidity SOL/USDC pair
      const pair = data.pairs.find(p =>
        p.quoteToken?.symbol === 'USDC' && p.liquidity?.usd > 1000000
      ) || data.pairs[0];

      const currentPrice = pair.priceUsd ? parseFloat(pair.priceUsd) : null;
      if (currentPrice) {
        // Add to rolling history
        priceHistory.push(currentPrice);
        if (priceHistory.length > MAX_HISTORY) priceHistory.shift();

        // If we have enough history, use it
        if (priceHistory.length >= 24) {
          return [...priceHistory];
        }

        // Otherwise use price changes as proxy
        const change24h = pair.priceChange?.h24 || 0;
        const change6h = pair.priceChange?.h6 || 0;
        const change1h = pair.priceChange?.h1 || 0;

        // Reconstruct approximate history from price changes
        const prices = [];
        const price24hAgo = currentPrice / (1 + change24h / 100);
        const price6hAgo = currentPrice / (1 + change6h / 100);
        const price1hAgo = currentPrice / (1 + change1h / 100);

        // Create synthetic 7 data points
        for (let i = 0; i < 7; i++) {
          const t = i / 6; // 0 to 1
          if (t < 0.14) prices.push(price24hAgo);
          else if (t < 0.75) prices.push(price24hAgo + (price6hAgo - price24hAgo) * ((t - 0.14) / 0.61));
          else prices.push(price6hAgo + (currentPrice - price6hAgo) * ((t - 0.75) / 0.25));
        }
        prices.push(currentPrice);
        return prices;
      }
    }
  } catch (err) {
    console.log(`[TREND] DexScreener fallback failed: ${err.message}`);
  }

  return null;
}

/**
 * Calculate Simple Moving Average
 */
function calcSMA(prices) {
  if (!prices || prices.length === 0) return 0;
  return prices.reduce((a, b) => a + b, 0) / prices.length;
}

/**
 * Get the current market trend for SOL
 * @returns {Promise<{trend: string, currentPrice: number, sma7d: number, deviation: number}>}
 *   trend: 'uptrend' | 'downtrend' | 'neutral'
 */
async function getMarketTrend() {
  // Check cache
  const now = Date.now();
  if (cachedTrend && (now - cacheTimestamp) < CACHE_TTL_MS) {
    return cachedTrend;
  }

  try {
    const prices = await fetchPriceHistory();
    if (!prices || prices.length < 3) {
      console.log('[TREND] Insufficient price data, returning neutral');
      return { trend: 'neutral', currentPrice: 0, sma7d: 0, deviation: 0 };
    }

    const currentPrice = prices[prices.length - 1];
    const sma7d = calcSMA(prices);
    const deviation = ((currentPrice - sma7d) / sma7d) * 100;

    let trend;
    if (deviation > 3) {
      trend = 'uptrend';
    } else if (deviation < -3) {
      trend = 'downtrend';
    } else {
      trend = 'neutral';
    }

    const result = { trend, currentPrice, sma7d, deviation };

    // Cache result
    cachedTrend = result;
    cacheTimestamp = now;

    console.log(`[TREND] SOL: $${currentPrice.toFixed(2)} | SMA7d: $${sma7d.toFixed(2)} | Dev: ${deviation.toFixed(1)}% | Trend: ${trend.toUpperCase()}`);
    return result;
  } catch (err) {
    writeAlert('ERROR', `[TREND] Analysis failed: ${err.message}`);
    return { trend: 'neutral', currentPrice: 0, sma7d: 0, deviation: 0 };
  }
}

module.exports = { getMarketTrend, fetchPriceHistory, calcSMA };
