/**
 * Drift Protocol integration - perpetual futures shorting
 *
 * Provides ability to open/close short positions on Drift DEX
 * using USDC as collateral. Supports dry-run mode.
 */
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { Wallet } = require('@coral-xyz/anchor');
const { DriftClient, initialize, PositionDirection, OrderType, MarketType, BN, BASE_PRECISION, PRICE_PRECISION, QUOTE_PRECISION, getMarketOrderParams, convertToNumber } = require('@drift-labs/sdk');
const bs58 = require('bs58');
const config = require('../config.json');
const { writeAlert } = require('./alerts');

let driftClient = null;
let initialized = false;

// Market index mapping for Drift perpetual markets
const PERP_MARKETS = {
  'SOL-PERP': 0,
  'BTC-PERP': 1,
  'ETH-PERP': 2,
  'APT-PERP': 3,
  'BONK-PERP': 4,
  'MATIC-PERP': 5,
  'ARB-PERP': 6,
  'DOGE-PERP': 7,
  'BNB-PERP': 8,
  'SUI-PERP': 9,
  'PEPE-PERP': 10,
  '1MPEPE-PERP': 10,
  'OP-PERP': 11,
  'RENDER-PERP': 12,
  'XRP-PERP': 13,
  'HNT-PERP': 14,
  'INJ-PERP': 15,
  'RNDR-PERP': 12,
  'LINK-PERP': 16,
  'RLB-PERP': 17,
  'PYTH-PERP': 18,
  'TIA-PERP': 19,
  'JTO-PERP': 20,
  'SEI-PERP': 21,
  'WIF-PERP': 22,
  'JUP-PERP': 23,
  'DYM-PERP': 24,
  'TAO-PERP': 25,
  'W-PERP': 26,
  'KMNO-PERP': 27,
  'TNSR-PERP': 28,
};

/**
 * Initialize DriftClient with wallet from environment
 */
async function initDrift() {
  if (initialized) return true;

  const driftConfig = config.drift;
  if (!driftConfig || !driftConfig.enabled) {
    console.log('[DRIFT] Drift integration disabled in config');
    return false;
  }

  try {
    const rpcUrl = config.rpc.helius || config.rpc.fallback;
    const connection = new Connection(rpcUrl, 'confirmed');

    // In dry-run mode, we don't need a real wallet connection
    if (config.mode !== 'live' || !process.env.SOLANA_PRIVATE_KEY) {
      console.log('[DRIFT] DRY-RUN mode — Drift client not initialized (simulated)');
      initialized = true;
      return true;
    }

    const decoded = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
    const keypair = Keypair.fromSecretKey(decoded);
    const wallet = new Wallet(keypair);

    const sdkConfig = initialize({ env: 'mainnet-beta' });

    driftClient = new DriftClient({
      connection,
      wallet,
      env: 'mainnet-beta',
    });

    await driftClient.subscribe();
    console.log(`[DRIFT] Client initialized for wallet ${keypair.publicKey.toBase58()}`);
    initialized = true;
    return true;
  } catch (err) {
    writeAlert('ERROR', `[DRIFT] Init failed: ${err.message}`);
    return false;
  }
}

/**
 * Get the market index for a perp market name
 */
function getMarketIndex(market) {
  const idx = PERP_MARKETS[market];
  if (idx === undefined) {
    throw new Error(`Unknown Drift perp market: ${market}. Available: ${Object.keys(PERP_MARKETS).join(', ')}`);
  }
  return idx;
}

/**
 * Open a short position on Drift
 * @param {string} market - Market name e.g. 'SOL-PERP'
 * @param {number} sizeUsdc - Position size in USDC notional
 * @param {number} leverage - Leverage multiplier (default from config)
 * @returns {object} { success, positionId, market, size, entryPrice, simulated }
 */
async function openShort(market, sizeUsdc, leverage) {
  const driftConfig = config.drift || {};
  leverage = leverage || driftConfig.leverage || 1;

  try {
    const marketIndex = getMarketIndex(market);

    // DRY-RUN mode
    if (config.mode !== 'live' || !driftClient) {
      const simulatedPrice = market === 'SOL-PERP' ? 150 : 1; // rough placeholder
      const baseAmount = sizeUsdc / simulatedPrice;

      console.log(`[DRIFT] DRY-RUN SHORT: ${market} | Size: $${sizeUsdc.toFixed(2)} | Leverage: ${leverage}x`);
      return {
        success: true,
        positionId: `drift-short-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        market,
        size: sizeUsdc,
        leverage,
        entryPrice: simulatedPrice,
        baseAmount,
        simulated: true,
        txId: `dry-run-drift-${Date.now()}`
      };
    }

    // LIVE: place market short order on Drift
    const baseAssetAmount = new BN(sizeUsdc * leverage)
      .mul(BASE_PRECISION)
      .div(QUOTE_PRECISION);

    const orderParams = getMarketOrderParams({
      marketIndex,
      direction: PositionDirection.SHORT,
      baseAssetAmount,
      marketType: MarketType.PERP,
    });

    const txId = await driftClient.placePerpOrder(orderParams);
    console.log(`[DRIFT] LIVE SHORT: ${market} | Size: $${sizeUsdc.toFixed(2)} | Leverage: ${leverage}x | tx: ${txId}`);

    // Get entry price from oracle
    const oracleData = driftClient.getOracleDataForPerpMarket(marketIndex);
    const entryPrice = convertToNumber(oracleData.price, PRICE_PRECISION);

    return {
      success: true,
      positionId: `drift-short-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      market,
      size: sizeUsdc,
      leverage,
      entryPrice,
      baseAmount: sizeUsdc / entryPrice,
      simulated: false,
      txId
    };
  } catch (err) {
    writeAlert('ERROR', `[DRIFT] Open short failed for ${market}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Close a short position on Drift
 * @param {string} market - Market name
 * @param {number} baseAmount - Base asset amount to close
 * @returns {object} { success, txId, simulated }
 */
async function closeShort(market, baseAmount) {
  try {
    const marketIndex = getMarketIndex(market);

    // DRY-RUN
    if (config.mode !== 'live' || !driftClient) {
      console.log(`[DRIFT] DRY-RUN CLOSE SHORT: ${market}`);
      return {
        success: true,
        txId: `dry-run-drift-close-${Date.now()}`,
        simulated: true
      };
    }

    // LIVE: close by placing opposite (long) market order
    const baseAssetAmountBN = new BN(Math.floor(baseAmount * 1e9));

    const orderParams = getMarketOrderParams({
      marketIndex,
      direction: PositionDirection.LONG,
      baseAssetAmount: baseAssetAmountBN,
      marketType: MarketType.PERP,
      reduceOnly: true,
    });

    const txId = await driftClient.placePerpOrder(orderParams);
    console.log(`[DRIFT] LIVE CLOSE SHORT: ${market} | tx: ${txId}`);

    return { success: true, txId, simulated: false };
  } catch (err) {
    writeAlert('ERROR', `[DRIFT] Close short failed for ${market}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Get all open short positions from Drift
 * In dry-run mode, returns empty (shorts tracked in state.json)
 */
async function getShortPositions() {
  if (config.mode !== 'live' || !driftClient) return [];

  try {
    const user = driftClient.getUser();
    const positions = user.getPerpPositions();
    return positions
      .filter(p => convertToNumber(p.baseAssetAmount, BASE_PRECISION) < 0)
      .map(p => ({
        marketIndex: p.marketIndex,
        baseAssetAmount: convertToNumber(p.baseAssetAmount, BASE_PRECISION),
        quoteAssetAmount: convertToNumber(p.quoteAssetAmount, QUOTE_PRECISION),
        entryPrice: convertToNumber(p.entryPrice || new BN(0), PRICE_PRECISION),
      }));
  } catch (err) {
    writeAlert('ERROR', `[DRIFT] Get positions failed: ${err.message}`);
    return [];
  }
}

/**
 * Get PnL for a specific short position (simulated mode uses price comparison)
 * @param {object} shortPos - Short position from state.json
 * @param {number} currentPrice - Current market price
 * @returns {{ pnl: number, pnlPercent: number }}
 */
function getShortPnl(shortPos, currentPrice) {
  // Short PnL: profit when price goes down
  const priceDiff = shortPos.entryPrice - currentPrice;
  const pnl = (priceDiff / shortPos.entryPrice) * shortPos.usdcSpent;
  const pnlPercent = (priceDiff / shortPos.entryPrice) * 100;
  return { pnl, pnlPercent };
}

module.exports = { initDrift, openShort, closeShort, getShortPositions, getShortPnl, getMarketIndex, PERP_MARKETS };
