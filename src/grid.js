/**
 * Grid Trading Strategy
 *
 * Places virtual buy/sell orders at fixed price intervals around current price.
 * When price drops to a grid level → buy. When price rises to next level → sell.
 * Profits from the spread between grid levels in choppy/sideways markets.
 *
 * Runs independently from momentum/mean reversion strategies.
 * Uses its own capital allocation and position tracking.
 */
const config = require('../config.json');
const { getTokenPrice } = require('./scanner');
const { executeBuy, executeSell } = require('./executor');
const { writeAlert } = require('./alerts');
const { fmtUsd } = require('./utils');
const { getState, saveState } = require('./state');

const gridConfig = config.grid || {};

/**
 * Initialize grid state in the bot state if not present
 */
function initGridState() {
  const state = getState();
  if (!state.grid) {
    state.grid = {
      tokens: {},       // { mint: GridTokenState }
      totalPnl: 0,
      totalTrades: 0,
      capitalAllocated: 0
    };
    saveState();
  }
  return state.grid;
}

/**
 * GridTokenState structure:
 * {
 *   token: string,
 *   mint: string,
 *   basePrice: number,          // Center price when grid was set up
 *   gridLevels: number[],       // All price levels
 *   filledBuys: [{              // Bought positions waiting to be sold
 *     level: number,            // Buy level price
 *     sellLevel: number,        // Target sell level
 *     amount: string,           // Token amount held
 *     usdcSpent: number,
 *     boughtAt: string,         // ISO timestamp
 *     txId: string
 *   }],
 *   lastPrice: number,
 *   lastCheck: string,
 *   active: boolean,
 *   capitalPerLevel: number,
 *   pnl: number,
 *   trades: number
 * }
 */

/**
 * Calculate grid levels around a base price
 * @param {number} basePrice - Center price
 * @param {number} spreadPct - Spread between levels (e.g., 2 = 2%)
 * @param {number} levels - Number of levels above AND below center
 * @returns {number[]} Sorted price levels
 */
function calculateGridLevels(basePrice, spreadPct, levels) {
  const multiplier = spreadPct / 100;
  const gridLevels = [basePrice];

  for (let i = 1; i <= levels; i++) {
    gridLevels.push(basePrice * (1 + multiplier * i));  // Above
    gridLevels.push(basePrice * (1 - multiplier * i));  // Below
  }

  return gridLevels.sort((a, b) => a - b);
}

/**
 * Set up a new grid for a token
 * @param {string} mint - Token mint address
 * @param {string} symbol - Token symbol
 * @param {number} currentPrice - Current token price
 */
function setupGrid(mint, symbol, currentPrice) {
  const grid = initGridState();
  const spreadPct = gridConfig.spreadPercent || 2;
  const levelsCount = gridConfig.levels || 5;
  const capitalPerLevel = gridConfig.capitalPerLevel || 5;

  const gridLevels = calculateGridLevels(currentPrice, spreadPct, levelsCount);
  const totalCapitalNeeded = capitalPerLevel * levelsCount; // Only buy levels need capital

  // Check available capital
  const state = getState();
  const availableForGrid = (gridConfig.maxCapital || 30) - grid.capitalAllocated;
  if (availableForGrid < totalCapitalNeeded) {
    console.log(`[GRID] Not enough capital for ${symbol} grid. Need $${totalCapitalNeeded}, available: $${availableForGrid.toFixed(2)}`);
    return null;
  }

  grid.tokens[mint] = {
    token: symbol,
    mint,
    basePrice: currentPrice,
    gridLevels,
    filledBuys: [],
    lastPrice: currentPrice,
    lastCheck: new Date().toISOString(),
    active: true,
    capitalPerLevel,
    pnl: 0,
    trades: 0
  };

  grid.capitalAllocated += totalCapitalNeeded;
  saveState();

  writeAlert('GRID_SETUP', `Grid set up for ${symbol} @ $${currentPrice.toFixed(6)} | ${gridLevels.length} levels | ${spreadPct}% spread | $${capitalPerLevel}/level`, {
    mint, levels: gridLevels, capitalAllocated: totalCapitalNeeded
  });

  console.log(`[GRID] Set up ${symbol}: ${gridLevels.length} levels, ${spreadPct}% spread, $${capitalPerLevel}/level`);
  return grid.tokens[mint];
}

/**
 * Find which grid level a price is closest to (below it = buy level)
 */
function findGridLevel(price, gridLevels) {
  let buyLevel = null;
  let sellLevel = null;

  for (let i = 0; i < gridLevels.length; i++) {
    if (gridLevels[i] <= price) {
      buyLevel = gridLevels[i];
      sellLevel = gridLevels[i + 1] || null;
    }
  }

  return { buyLevel, sellLevel };
}

/**
 * Check if price has crossed a grid level and execute trades
 * @param {string} mint - Token mint
 */
async function checkGrid(mint) {
  const grid = initGridState();
  const tokenGrid = grid.tokens[mint];
  if (!tokenGrid || !tokenGrid.active) return;

  const priceData = await getTokenPrice(mint);
  if (!priceData) return;

  const currentPrice = priceData.price;
  const prevPrice = tokenGrid.lastPrice;
  tokenGrid.lastPrice = currentPrice;
  tokenGrid.lastCheck = new Date().toISOString();

  // ── Check for SELL opportunities (filled buys that hit their sell level) ──
  for (let i = tokenGrid.filledBuys.length - 1; i >= 0; i--) {
    const buy = tokenGrid.filledBuys[i];
    if (currentPrice >= buy.sellLevel) {
      console.log(`[GRID] SELL trigger: ${tokenGrid.token} @ $${currentPrice.toFixed(6)} (target: $${buy.sellLevel.toFixed(6)})`);

      const result = await executeSell(mint, buy.amount, tokenGrid.token);
      if (result.success) {
        const usdcReceived = result.usdcReceived || (buy.usdcSpent * (currentPrice / buy.level));
        const pnl = usdcReceived - buy.usdcSpent;

        tokenGrid.filledBuys.splice(i, 1);
        tokenGrid.pnl += pnl;
        tokenGrid.trades++;
        grid.totalPnl += pnl;
        grid.totalTrades++;

        // Return capital for reuse
        grid.capitalAllocated = Math.max(0, grid.capitalAllocated - buy.usdcSpent);
        // Re-allocate for next buy at same level
        grid.capitalAllocated += tokenGrid.capitalPerLevel;

        writeAlert('GRID_SELL', `Grid SELL ${tokenGrid.token}: ${fmtUsd(usdcReceived)} (+${fmtUsd(pnl)}) | Grid PnL: ${fmtUsd(tokenGrid.pnl)}`, {
          mint, level: buy.sellLevel, pnl, txId: result.txId
        });

        saveState();
      }
    }
  }

  // ── Check for BUY opportunities (price dropped to a grid level) ──
  const { buyLevel, sellLevel } = findGridLevel(currentPrice, tokenGrid.gridLevels);
  if (!buyLevel || !sellLevel) return;

  // Only buy if price CROSSED DOWN through this level (was above, now at/below)
  if (prevPrice > buyLevel && currentPrice <= buyLevel * 1.002) {
    // Check if we already have a filled buy at this level
    const alreadyFilled = tokenGrid.filledBuys.some(b =>
      Math.abs(b.level - buyLevel) / buyLevel < 0.005
    );
    if (alreadyFilled) return;

    // Check capital
    const availableForGrid = (gridConfig.maxCapital || 30) - grid.capitalAllocated;
    if (availableForGrid < tokenGrid.capitalPerLevel) {
      console.log(`[GRID] Skip buy ${tokenGrid.token} @ $${buyLevel.toFixed(6)}: no grid capital`);
      return;
    }

    console.log(`[GRID] BUY trigger: ${tokenGrid.token} @ $${currentPrice.toFixed(6)} (level: $${buyLevel.toFixed(6)})`);

    const result = await executeBuy(mint, tokenGrid.capitalPerLevel, tokenGrid.token);
    if (result.success) {
      tokenGrid.filledBuys.push({
        level: buyLevel,
        sellLevel,
        amount: result.outputAmount,
        usdcSpent: tokenGrid.capitalPerLevel,
        boughtAt: new Date().toISOString(),
        txId: result.txId
      });

      grid.capitalAllocated += tokenGrid.capitalPerLevel;

      writeAlert('GRID_BUY', `Grid BUY ${tokenGrid.token}: ${fmtUsd(tokenGrid.capitalPerLevel)} @ $${currentPrice.toFixed(6)} | Sell target: $${sellLevel.toFixed(6)}`, {
        mint, level: buyLevel, sellLevel, txId: result.txId
      });

      saveState();
    }
  }
}

/**
 * Main grid loop — check all active grids
 */
async function gridLoop() {
  const grid = initGridState();
  const activeMints = Object.keys(grid.tokens).filter(m => grid.tokens[m].active);

  if (activeMints.length === 0) return;

  for (const mint of activeMints) {
    try {
      await checkGrid(mint);
    } catch (err) {
      writeAlert('ERROR', `Grid check error for ${grid.tokens[mint]?.token}: ${err.message}`);
    }
  }
}

/**
 * Auto-select tokens for grid trading based on criteria:
 * - High liquidity (>$2M)
 * - Low volatility (small 24h change)
 * - High volume (active trading)
 */
function isGoodGridCandidate(token) {
  const absChange24h = Math.abs(token.priceChange24h || 0);
  const minLiquidity = gridConfig.minLiquidity || 2000000;
  const maxVolatility = gridConfig.maxVolatility24h || 8;

  return (
    token.liquidity >= minLiquidity &&
    absChange24h <= maxVolatility &&
    token.volume24h >= 500000
  );
}

/**
 * Scan for new grid candidates and set up grids
 * Called periodically (less frequent than main scan)
 */
async function gridScanLoop(candidates) {
  const grid = initGridState();
  const maxGridTokens = gridConfig.maxTokens || 3;
  const activeCount = Object.values(grid.tokens).filter(t => t.active).length;

  if (activeCount >= maxGridTokens) return;

  // Filter for good grid candidates not already in grid
  const gridCandidates = candidates
    .filter(t => isGoodGridCandidate(t) && !grid.tokens[t.mint])
    .sort((a, b) => b.liquidity - a.liquidity)  // Prefer highest liquidity
    .slice(0, maxGridTokens - activeCount);

  for (const token of gridCandidates) {
    setupGrid(token.mint, token.token, token.price);
  }
}

/**
 * Remove a grid (stop trading)
 */
function removeGrid(mint) {
  const grid = initGridState();
  const tokenGrid = grid.tokens[mint];
  if (!tokenGrid) return false;

  tokenGrid.active = false;
  // Note: filledBuys remain — they should be sold manually or left to hit sell levels
  console.log(`[GRID] Deactivated grid for ${tokenGrid.token}. ${tokenGrid.filledBuys.length} open positions remain.`);
  saveState();
  return true;
}

/**
 * Get grid status summary
 */
function getGridStatus() {
  const grid = initGridState();
  const tokens = Object.values(grid.tokens);
  const active = tokens.filter(t => t.active);

  return {
    activeGrids: active.length,
    totalPnl: grid.totalPnl,
    totalTrades: grid.totalTrades,
    capitalAllocated: grid.capitalAllocated,
    grids: active.map(t => ({
      token: t.token,
      basePrice: t.basePrice,
      lastPrice: t.lastPrice,
      openBuys: t.filledBuys.length,
      pnl: t.pnl,
      trades: t.trades
    }))
  };
}

module.exports = {
  initGridState,
  setupGrid,
  gridLoop,
  gridScanLoop,
  removeGrid,
  getGridStatus,
  isGoodGridCandidate
};
