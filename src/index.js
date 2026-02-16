/**
 * Solana Momentum Trading Bot - Main Daemon
 *
 * Scans for momentum signals on Solana tokens, executes trades via Jupiter,
 * manages risk with SL/TP and portfolio kill switch.
 *
 * Default: DRY-RUN mode (no real trades)
 */
const config = require('../config.json');
const { loadState, getState, addPosition, closePosition, deductCapital, saveState } = require('./state');
const { scanTokens, getTokenPrice } = require('./scanner');
const { detectSignals } = require('./signals');
const { initExecutor, executeBuy, executeSell } = require('./executor');
const { canOpenPosition, calculatePositionSize, calculateSLTP, checkPosition, hasPosition, portfolioCheck } = require('./risk');
const { writeAlert } = require('./alerts');
const { sleep, fmtUsd, shortAddr } = require('./utils');
const { gridLoop, gridScanLoop, initGridState, getGridStatus } = require('./grid');

let running = true;
let scanTimer = null;
let positionTimer = null;
let heartbeatTimer = null;
let gridTimer = null;
let gridScanTimer = null;

/** Generate a unique position ID */
function posId() { return `pos-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`; }

/**
 * SCAN LOOP: Find and enter new positions
 */
async function scanLoop() {
  if (!running) return;
  try {
    const check = canOpenPosition();
    if (!check.allowed) {
      console.log(`[SCAN] Skipping: ${check.reason}`);
      return;
    }

    // Scan for candidates
    const candidates = await scanTokens();
    if (candidates.length === 0) return;

    // Feed candidates to grid scanner (if enabled)
    if (config.grid?.enabled) {
      await gridScanLoop(candidates).catch(err =>
        writeAlert('ERROR', `Grid scan error: ${err.message}`)
      );
    }

    // Detect signals
    const signals = detectSignals(candidates);
    if (signals.length === 0) return;

    // Try to open positions for top signals
    for (const signal of signals.slice(0, 3)) {
      const recheck = canOpenPosition();
      if (!recheck.allowed) break;

      // Skip if we already hold this token
      if (hasPosition(signal.mint)) continue;

      const size = calculatePositionSize(signal);
      if (size < 5) continue;

      console.log(`[SCAN] Opening position: ${signal.token} (${signal.strategy || 'momentum'}, score: ${signal.score}, size: ${fmtUsd(size)})`);

      const result = await executeBuy(signal.mint, size, signal.token);
      if (!result.success) continue;

      const strategy = signal.strategy || 'momentum';
      const { stopLoss, takeProfit } = calculateSLTP(signal.price, strategy);

      const position = {
        id: posId(),
        token: signal.token,
        mint: signal.mint,
        entryPrice: signal.price,
        amount: result.outputAmount,
        usdcSpent: size,
        openedAt: new Date().toISOString(),
        stopLoss,
        takeProfit,
        txId: result.txId,
        simulated: result.simulated || false,
        signalScore: signal.score,
        signalReasons: signal.reasons,
        strategy
      };

      addPosition(position);
      deductCapital(size);

      writeAlert('TRADE_OPEN', `Opened ${signal.token}: ${fmtUsd(size)} @ $${signal.price.toFixed(6)} | SL: $${stopLoss.toFixed(6)} | TP: $${takeProfit.toFixed(6)}`, position);

      await sleep(1000); // Rate limit between trades
    }
  } catch (err) {
    writeAlert('ERROR', `Scan loop error: ${err.message}`);
  }
}

/**
 * POSITION CHECK LOOP: Monitor open positions for SL/TP
 */
async function positionLoop() {
  if (!running) return;
  try {
    const state = getState();
    if (state.positions.length === 0) return;

    for (const pos of [...state.positions]) {
      const priceData = await getTokenPrice(pos.mint);
      if (!priceData) continue;

      const currentPrice = priceData.price;
      const { shouldClose, reason } = checkPosition(pos, currentPrice);

      if (shouldClose) {
        console.log(`[POSITION] Closing ${pos.token}: ${reason} @ $${currentPrice.toFixed(6)} (entry: $${pos.entryPrice.toFixed(6)})`);

        const result = await executeSell(pos.mint, pos.amount, pos.token);
        if (result.success) {
          const usdcReceived = result.usdcReceived || (pos.usdcSpent * (currentPrice / pos.entryPrice));
          closePosition(pos.id, currentPrice, usdcReceived, reason);
        }
      } else {
        const pnl = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100).toFixed(1);
        console.log(`[POSITION] ${pos.token}: $${currentPrice.toFixed(6)} (${pnl}%)`);
      }

      await sleep(500); // Rate limit
    }
  } catch (err) {
    writeAlert('ERROR', `Position loop error: ${err.message}`);
  }
}

/**
 * HEARTBEAT: Periodic health check
 */
function heartbeat() {
  const summary = portfolioCheck();

  // Include grid status in heartbeat
  if (config.grid?.enabled) {
    const gridStatus = getGridStatus();
    summary.grid = gridStatus;
    if (gridStatus.activeGrids > 0) {
      writeAlert('GRID_STATUS', `Grids: ${gridStatus.activeGrids} active | PnL: $${gridStatus.totalPnl.toFixed(2)} | Trades: ${gridStatus.totalTrades} | Capital: $${gridStatus.capitalAllocated.toFixed(2)}`, gridStatus);
    }
  }

  writeAlert('HEARTBEAT', `Bot alive | Mode: ${config.mode} | Uptime: running`, summary);
}

/**
 * Graceful shutdown
 */
function shutdown(signal) {
  console.log(`\n[BOT] Shutting down (${signal})...`);
  running = false;
  clearInterval(scanTimer);
  clearInterval(positionTimer);
  clearInterval(heartbeatTimer);
  clearInterval(gridTimer);
  clearInterval(gridScanTimer);
  saveState();
  console.log('[BOT] State saved. Goodbye!');
  process.exit(0);
}

/**
 * MAIN: Boot the bot
 */
async function main() {
  console.log('='.repeat(60));
  console.log('  Solana Trading Bot (Momentum + Mean Reversion)');
  console.log(`  Mode: ${config.mode.toUpperCase()}`);
  console.log(`  Wallet: ${config.wallet}`);
  console.log(`  Capital: $${config.capital.starting} USDC`);
  console.log(`  Max position: $${config.risk.maxPositionSize} | Max positions: ${config.risk.maxPositions}`);
  console.log(`  SL: ${config.risk.stopLossPercent}% | TP: +${config.risk.takeProfitPercent}%`);
  console.log(`  Kill switch: ${config.risk.portfolioKillSwitchPercent}%`);
  console.log('='.repeat(60));

  // Load persisted state
  loadState();

  // Init executor (wallet + RPC)
  initExecutor();

  // Handle shutdown signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    writeAlert('ERROR', `Uncaught exception: ${err.message}`, { stack: err.stack });
    console.error(err);
  });
  process.on('unhandledRejection', (err) => {
    writeAlert('ERROR', `Unhandled rejection: ${err?.message || err}`, {});
    console.error(err);
  });

  // Initial heartbeat
  heartbeat();

  // Start loops
  console.log(`[BOT] Starting scan loop (every ${config.intervals.scanMs / 1000}s)...`);
  console.log(`[BOT] Starting position monitor (every ${config.intervals.positionCheckMs / 1000}s)...`);
  console.log(`[BOT] Heartbeat every ${config.intervals.heartbeatMs / 60000} minutes`);

  // Run first scan immediately
  await scanLoop();

  // Schedule recurring loops
  scanTimer = setInterval(scanLoop, config.intervals.scanMs);
  positionTimer = setInterval(positionLoop, config.intervals.positionCheckMs);
  heartbeatTimer = setInterval(heartbeat, config.intervals.heartbeatMs);

  // Start grid trading if enabled
  if (config.grid?.enabled) {
    initGridState();
    const gridCheckMs = config.grid.checkIntervalMs || 15000;
    gridTimer = setInterval(() => {
      gridLoop().catch(err => writeAlert('ERROR', `Grid loop error: ${err.message}`));
    }, gridCheckMs);
    console.log(`[BOT] Grid trading enabled (check every ${gridCheckMs / 1000}s, ${config.grid.levels} levels, ${config.grid.spreadPercent}% spread)`);
  }

  console.log('[BOT] All systems go! 🚀');
}

// Boot
main().catch(err => {
  console.error('[BOT] Fatal error:', err);
  process.exit(1);
});
