/**
 * Risk manager - position sizing, SL/TP, portfolio limits, kill switch
 */
const config = require('../config.json');
const { getState, triggerKillSwitch } = require('./state');
const { writeAlert } = require('./alerts');

/**
 * Check if we can open a new position
 * @returns {{ allowed: boolean, reason?: string, maxSize: number }}
 */
function canOpenPosition() {
  const state = getState();

  // Kill switch check
  if (state.killSwitchTriggered) {
    return { allowed: false, reason: 'Kill switch active' };
  }

  // Check total PnL against kill switch threshold
  const pnlPercent = (state.totalPnl / state.initialCapital) * 100;
  if (pnlPercent <= config.risk.portfolioKillSwitchPercent) {
    triggerKillSwitch();
    return { allowed: false, reason: `Kill switch triggered: ${pnlPercent.toFixed(1)}% total loss` };
  }

  // Max positions check
  if (state.positions.length >= config.risk.maxPositions) {
    return { allowed: false, reason: `Max positions (${config.risk.maxPositions}) reached` };
  }

  // Capital check
  const available = state.capitalUsdc;
  if (available < 5) {
    return { allowed: false, reason: `Insufficient capital: $${available.toFixed(2)}` };
  }

  const maxSize = Math.min(config.risk.maxPositionSize, available);
  return { allowed: true, maxSize };
}

/**
 * Calculate position size for a signal
 * @param {object} signal - Signal with score 0-100
 * @returns {number} USDC amount to invest
 */
function calculatePositionSize(signal) {
  const { maxSize } = canOpenPosition();
  if (!maxSize) return 0;

  // Scale position size by signal strength (50-100 score maps to 50-100% of max)
  const scaleFactor = 0.5 + (signal.score / 100) * 0.5;
  return Math.min(maxSize, Number((maxSize * scaleFactor).toFixed(2)));
}

/**
 * Calculate stop-loss and take-profit prices
 * Mean reversion uses tighter bounds (smaller moves, quicker exits)
 * @param {number} entryPrice - Entry price
 * @param {string} strategy - 'momentum' or 'meanReversion'
 * @returns {{ stopLoss: number, takeProfit: number }}
 */
function calculateSLTP(entryPrice, strategy = 'momentum') {
  if (strategy === 'meanReversion') {
    // Tighter: -8% SL, +10% TP (mean reversion = smaller, faster trades)
    return {
      stopLoss: entryPrice * 0.92,
      takeProfit: entryPrice * 1.10
    };
  }
  return {
    stopLoss: entryPrice * (1 + config.risk.stopLossPercent / 100),    // e.g. -15% = 0.85x
    takeProfit: entryPrice * (1 + config.risk.takeProfitPercent / 100)  // e.g. +30% = 1.30x
  };
}

/**
 * Check if any open position should be closed (SL/TP hit)
 * @param {object} position - Open position
 * @param {number} currentPrice - Current token price
 * @returns {{ shouldClose: boolean, reason?: string }}
 */
function checkPosition(position, currentPrice) {
  if (currentPrice <= position.stopLoss) {
    return { shouldClose: true, reason: 'STOP_LOSS' };
  }
  if (currentPrice >= position.takeProfit) {
    return { shouldClose: true, reason: 'TAKE_PROFIT' };
  }
  return { shouldClose: false };
}

/**
 * Check if token is already in our positions (avoid duplicates)
 */
function hasPosition(mint) {
  return getState().positions.some(p => p.mint === mint);
}

/**
 * Portfolio health check
 */
function portfolioCheck() {
  const state = getState();
  const pnlPercent = state.initialCapital > 0
    ? (state.totalPnl / state.initialCapital) * 100 : 0;

  const summary = {
    capital: state.capitalUsdc,
    openPositions: state.positions.length,
    totalPnl: state.totalPnl,
    pnlPercent,
    closedTrades: state.closedTrades.length,
    killSwitch: state.killSwitchTriggered
  };

  writeAlert('PORTFOLIO_UPDATE', `Capital: $${state.capitalUsdc.toFixed(2)} | PnL: $${state.totalPnl.toFixed(2)} (${pnlPercent.toFixed(1)}%) | Open: ${state.positions.length}`, summary);
  return summary;
}

module.exports = { canOpenPosition, calculatePositionSize, calculateSLTP, checkPosition, hasPosition, portfolioCheck };
