/**
 * Token Scanner - fetches trending/high-volume Solana tokens from DexScreener
 */
const config = require('../config.json');
const { safeFetch } = require('./utils');
const { writeAlert } = require('./alerts');

const BASE = config.apis.dexscreener;

// Established Solana tokens to always monitor for momentum
const WATCHLIST = [
  { symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112' },
  { symbol: 'JUP', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { symbol: 'RAY', mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R' },
  { symbol: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'WIF', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
  { symbol: 'PYTH', mint: 'HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3' },
  { symbol: 'ORCA', mint: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE' },
  { symbol: 'MNDE', mint: 'MNDEFzGvMt87ueuHvVU9VcTqsAP5b3fTGPsHuuPA5ey' },
  { symbol: 'RENDER', mint: 'rndrizKT3MK1iimdxRdWabcF7Zg7AR5T4nud4EkHBof' },
  { symbol: 'HNT', mint: 'hntyVP6YFm1Hg25TN9WGLqM12b8TQmcknKrdu1oxWux' },
  { symbol: 'JITO', mint: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn' },
  { symbol: 'W', mint: '85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ' },
  { symbol: 'TENSOR', mint: 'TNSRxcUxoT9xBG3de7PiJyTDYu7kskLqcpddxnEJAS6' },
  { symbol: 'MOBILE', mint: 'mb1eu7TzEc71KxDpsmsKoucSSuuoGLv1drys1oP2jh6' },
  { symbol: 'DRIFT', mint: 'DriFtupJYLTosbwoN8koMbEYSx54aFAVLddWsbksjwg7' },
  { symbol: 'POPCAT', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' },
  { symbol: 'MEW', mint: 'MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5' },
  { symbol: 'KMNO', mint: 'KMNo3nJsBXfcpJTVhZcXLW7RmTwTt4GVFE7suUBo9sS' },
  { symbol: 'SAMO', mint: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU' },
  { symbol: 'BOME', mint: 'ukHH6c7mMyiWCf1b9pnWe25TSpkDDt3H5pQZgZ74J82' },
  { symbol: 'WEN', mint: 'WENWENvqqNya429ubCdR81ZmD69brwQaaBYY6p3LCpk' },
  { symbol: 'TRUMP', mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN' },
  { symbol: 'AI16Z', mint: 'HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC' },
  { symbol: 'FARTCOIN', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump' },
];

/**
 * Get trending/boosted tokens on Solana from DexScreener
 * Returns filtered token pairs meeting our criteria
 */
async function scanTokens() {
  try {
    // 1. Get top Solana pairs by volume (search endpoint)
    const searchData = await safeFetch(
      `${BASE}/token-profiles/latest/v1`,
      {}, 15000
    ).catch(() => null);

    // 2. Get boosted tokens
    const boostedData = await safeFetch(
      `${BASE}/token-boosts/latest/v1`,
      {}, 15000
    ).catch(() => null);

    // Collect Solana token addresses from boosted/trending
    const solanaAddresses = new Set();

    if (Array.isArray(searchData)) {
      searchData.filter(t => t.chainId === 'solana').forEach(t => solanaAddresses.add(t.tokenAddress));
    }
    if (Array.isArray(boostedData)) {
      boostedData.filter(t => t.chainId === 'solana').forEach(t => solanaAddresses.add(t.tokenAddress));
    }

    // 3. CoinGecko trending — cross-reference Solana tokens
    const cgTrending = await safeFetch(
      'https://api.coingecko.com/api/v3/search/trending',
      {}, 15000
    ).catch(() => null);

    if (cgTrending?.coins) {
      for (const coin of cgTrending.coins) {
        const solAddr = coin.item?.platforms?.['solana'];
        if (solAddr) solanaAddresses.add(solAddr);
      }
    }

    // 4. DexScreener search for top Solana gainers
    const searches = ['SOL', 'USDC', 'trending'];
    for (const q of searches) {
      const searchResult = await safeFetch(
        `${BASE}/latest/dex/search?q=${q}`,
        {}, 15000
      ).catch(() => null);
      if (searchResult?.pairs) {
        for (const pair of searchResult.pairs) {
          if (pair.chainId === 'solana' && pair.baseToken?.address) {
            solanaAddresses.add(pair.baseToken.address);
          }
        }
      }
    }

    // 5. Always include our established watchlist
    for (const token of WATCHLIST) {
      solanaAddresses.add(token.mint);
    }

    // If we got addresses, fetch their pair data
    // Prioritize watchlist tokens, then trending
    const candidates = [];
    const watchlistMints = WATCHLIST.map(w => w.mint);
    const trendingAddrs = [...solanaAddresses].filter(a => !watchlistMints.includes(a));
    const addresses = [...watchlistMints, ...trendingAddrs.slice(0, 60)]; // Watchlist first, then up to 60 trending

    if (addresses.length > 0) {
      // Batch fetch - DexScreener allows comma-separated (up to 30)
      // Split into chunks of 30
      const chunks = [];
      for (let i = 0; i < addresses.length; i += 30) {
        chunks.push(addresses.slice(i, i + 30));
      }
      let pairsData = [];
      for (const chunk of chunks) {
        const batchUrl = `${BASE}/tokens/v1/solana/${chunk.join(',')}`;
        const data = await safeFetch(batchUrl, {}, 15000).catch(() => null);
        if (Array.isArray(data)) pairsData = pairsData.concat(data);
      }

      if (pairsData.length > 0) {
        // Group by base token, keep highest liquidity pair per token
        const bestPairs = new Map();
        for (const pair of pairsData) {
          const mint = pair.baseToken?.address;
          if (!mint) continue;
          const existing = bestPairs.get(mint);
          if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity?.usd || 0)) {
            bestPairs.set(mint, pair);
          }
        }

        for (const pair of bestPairs.values()) {
          if (passesFilters(pair)) {
            candidates.push(normalizePair(pair));
          }
        }
      }
    }

    // 4. Also search for high-volume Solana pairs directly
    const topPairs = await safeFetch(
      `${BASE}/latest/dex/search?q=SOL/USDC`,
      {}, 15000
    ).catch(() => null);

    if (topPairs?.pairs) {
      for (const pair of topPairs.pairs) {
        if (pair.chainId === 'solana' && passesFilters(pair)) {
          const norm = normalizePair(pair);
          if (!candidates.find(c => c.mint === norm.mint)) {
            candidates.push(norm);
          }
        }
      }
    }

    const watchlistCount = WATCHLIST.length;
    const trendingCount = solanaAddresses.size - watchlistCount;

    // Debug: log filter rejections for watchlist tokens
    if (candidates.length === 0 && addresses.length > 0) {
      const batchUrl2 = `${BASE}/tokens/v1/solana/${addresses.slice(0,5).join(',')}`;
      const sampleData = await safeFetch(batchUrl2, {}, 15000).catch(() => null);
      if (Array.isArray(sampleData) && sampleData.length > 0) {
        const bestPairs2 = new Map();
        for (const pair of sampleData) {
          const mint = pair.baseToken?.address;
          if (!mint) continue;
          const existing = bestPairs2.get(mint);
          if (!existing || (pair.liquidity?.usd || 0) > (existing.liquidity?.usd || 0)) {
            bestPairs2.set(mint, pair);
          }
        }
        for (const pair of [...bestPairs2.values()].slice(0, 3)) {
          passesFilters(pair, true);
        }
      }
    }

    console.log(`[SCANNER] Found ${candidates.length} candidates from ${trendingCount} trending + ${watchlistCount} watchlist tokens`);
    return candidates;

  } catch (err) {
    writeAlert('ERROR', `Scanner error: ${err.message}`);
    return [];
  }
}

/**
 * Get current price data for a specific token mint
 */
async function getTokenPrice(mint) {
  try {
    const data = await safeFetch(`${BASE}/tokens/v1/solana/${mint}`, {}, 10000);
    if (Array.isArray(data) && data.length > 0) {
      // Return the pair with highest liquidity
      const sorted = data.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
      return {
        price: parseFloat(sorted[0].priceUsd || 0),
        liquidity: sorted[0].liquidity?.usd || 0,
        volume24h: sorted[0].volume?.h24 || 0,
        priceChange24h: sorted[0].priceChange?.h24 || 0
      };
    }
    return null;
  } catch (err) {
    console.error(`[SCANNER] Price fetch error for ${mint}: ${err.message}`);
    return null;
  }
}

/** Check if a pair meets our minimum filters */
function passesFilters(pair, verbose = false) {
  const liq = pair.liquidity?.usd || 0;
  const vol = pair.volume?.h24 || 0;
  const age = pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 3600000 : 0;
  const symbol = pair.baseToken?.symbol || 'UNKNOWN';

  const pass = (
    pair.chainId === 'solana' &&
    liq >= config.filters.minLiquidityUsd &&
    vol >= config.filters.minVolume24h &&
    age >= config.filters.minAgeHours
  );

  if (!pass && verbose) {
    const reasons = [];
    if (liq < config.filters.minLiquidityUsd) reasons.push(`liq $${(liq/1000).toFixed(0)}k < $${config.filters.minLiquidityUsd/1000000}M`);
    if (vol < config.filters.minVolume24h) reasons.push(`vol $${(vol/1000).toFixed(0)}k < $${config.filters.minVolume24h/1000}k`);
    if (age < config.filters.minAgeHours) reasons.push(`age ${age.toFixed(0)}h < ${config.filters.minAgeHours}h`);
    if (verbose) console.log(`[SCANNER] ❌ ${symbol}: ${reasons.join(' | ')}`);
  }

  return pass;
}

/** Normalize a DexScreener pair into our internal format */
function normalizePair(pair) {
  return {
    token: pair.baseToken?.symbol || 'UNKNOWN',
    mint: pair.baseToken?.address || '',
    price: parseFloat(pair.priceUsd || 0),
    liquidity: pair.liquidity?.usd || 0,
    volume24h: pair.volume?.h24 || 0,
    volume6h: pair.volume?.h6 || 0,
    volume1h: pair.volume?.h1 || 0,
    priceChange24h: pair.priceChange?.h24 || 0,
    priceChange6h: pair.priceChange?.h6 || 0,
    priceChange1h: pair.priceChange?.h1 || 0,
    txns24h: pair.txns?.h24 || { buys: 0, sells: 0 },
    pairAddress: pair.pairAddress || '',
    dexId: pair.dexId || '',
    pairCreatedAt: pair.pairCreatedAt || 0
  };
}

module.exports = { scanTokens, getTokenPrice };
