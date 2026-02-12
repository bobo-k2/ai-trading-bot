/**
 * State persistence - survives restarts via JSON file
 */
const fs = require('fs');
const config = require('../config.json');
const { writeAlert } = require('./alerts');

const DEFAULT_STATE = {
  startedAt: new Date().toISOString(),
  capitalUsdc: config.capital.starting,
  initialCapital: config.capital.starting,
  positions: [],       // { id, token, mint, entryPrice, amount, usdcSpent, openedAt, stopLoss, takeProfit }
  closedTrades: [],    // { ...position, exitPrice, usdcReceived, closedAt, pnl, pnlPercent, reason }
  totalPnl: 0,
  tradeCount: 0,
  killSwitchTriggered: false
};

let state = null;

/** Load state from disk or create default */
function loadState() {
  try {
    if (fs.existsSync(config.stateFile)) {
      const raw = fs.readFileSync(config.stateFile, 'utf-8');
      state = JSON.parse(raw);
      console.log(`[STATE] Loaded state: ${state.positions.length} open positions, PnL: $${state.totalPnl.toFixed(2)}`);
    } else {
      state = { ...DEFAULT_STATE, startedAt: new Date().toISOString() };
      saveState();
      console.log('[STATE] Initialized fresh state');
    }
  } catch (err) {
    console.error(`[STATE] Error loading state, starting fresh: ${err.message}`);
    state = { ...DEFAULT_STATE, startedAt: new Date().toISOString() };
    saveState();
  }
  return state;
}

/** Save state to disk */
function saveState() {
  try {
    fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[STATE] Failed to save: ${err.message}`);
  }
}

/** Get current state (read-only reference) */
function getState() { return state; }

/** Add a new open position */
function addPosition(pos) {
  state.positions.push(pos);
  state.tradeCount++;
  saveState();
}

/** Close a position and move to history */
function closePosition(posId, exitPrice, usdcReceived, reason) {
  const idx = state.positions.findIndex(p => p.id === posId);
  if (idx === -1) return null;

  const pos = state.positions.splice(idx, 1)[0];
  const pnl = usdcReceived - pos.usdcSpent;
  const pnlPercent = (pnl / pos.usdcSpent) * 100;

  const closed = {
    ...pos, exitPrice, usdcReceived,
    closedAt: new Date().toISOString(),
    pnl: Number(pnl.toFixed(4)),
    pnlPercent: Number(pnlPercent.toFixed(2)),
    reason
  };

  state.closedTrades.push(closed);
  state.totalPnl = Number((state.totalPnl + pnl).toFixed(4));
  state.capitalUsdc = Number((state.capitalUsdc + usdcReceived).toFixed(4));
  saveState();

  writeAlert('TRADE_CLOSE', `Closed ${pos.token}: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPercent.toFixed(1)}%) [${reason}]`, closed);
  return closed;
}

/** Update available capital after opening a trade */
function deductCapital(amount) {
  state.capitalUsdc = Number((state.capitalUsdc - amount).toFixed(4));
  saveState();
}

/** Set kill switch */
function triggerKillSwitch() {
  state.killSwitchTriggered = true;
  saveState();
  writeAlert('ERROR', 'KILL SWITCH TRIGGERED - stopping all trading', { totalPnl: state.totalPnl });
}

module.exports = { loadState, saveState, getState, addPosition, closePosition, deductCapital, triggerKillSwitch };
