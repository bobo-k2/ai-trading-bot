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
const { initDrift, openShort, closeShort, getShortPnl } = require('./drift');
const { getMarketTrend } = require('./trend');

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

    // Check market trend for short/long decision
    const driftConfig = config.drift || {};
    let trend = { trend: 'neutral' };
    if (driftConfig.enabled) {
      try {
        trend = await getMarketTrend();
      } catch (err) {
        console.log(`[SCAN] Trend check failed: ${err.message}`);
      }
    }

    // Try to open positions for top signals
    for (const signal of signals.slice(0, 3)) {
      const recheck = canOpenPosition();
      if (!recheck.allowed) break;

      // Skip if we already hold this token
      if (hasPosition(signal.mint)) continue;

      // In downtrend: skip mean reversion longs, open shorts instead
      if (driftConfig.enabled && trend.trend === 'downtrend' && signal.strategy === 'meanReversion') {
        console.log(`[SCAN] Skipping mean reversion long for ${signal.token} — downtrend detected, will short instead`);
        continue;
      }

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

    // ── DRIFT SHORTING: Open shorts in downtrend ──
    if (driftConfig.enabled && trend.trend === 'downtrend') {
      const state = getState();
      const openShorts = (state.positions || []).filter(p => p.strategy === 'driftShort');
      const maxShorts = driftConfig.maxShorts || 3;

      if (openShorts.length < maxShorts) {
        for (const market of (driftConfig.markets || ['SOL-PERP'])) {
          // Check if we already have a short on this market
          if (openShorts.some(s => s.market === market)) continue;
          if (openShorts.length >= maxShorts) break;

          const shortSize = Math.min(
            driftConfig.maxShortSize || 30,
            20 + Math.random() * 10 // $20-30 range
          );

          console.log(`[SCAN] Downtrend detected — opening short: ${market} ${fmtUsd(shortSize)}`);

          const result = await openShort(market, shortSize, driftConfig.leverage || 1);
          if (!result.success) continue;

          const slPercent = driftConfig.stopLossPercent || 8;
          const tpPercent = driftConfig.takeProfitPercent || 10;

          const shortPosition = {
            id: result.positionId,
            token: market,
            mint: market, // use market name as mint for shorts
            market,
            entryPrice: result.entryPrice,
            baseAmount: result.baseAmount,
            usdcSpent: shortSize,
            openedAt: new Date().toISOString(),
            stopLoss: result.entryPrice * (1 + slPercent / 100),   // short SL is price UP
            takeProfit: result.entryPrice * (1 - tpPercent / 100), // short TP is price DOWN
            txId: result.txId,
            simulated: result.simulated || false,
            strategy: 'driftShort',
            leverage: driftConfig.leverage || 1
          };

          addPosition(shortPosition);
          deductCapital(shortSize);

          writeAlert('TRADE_OPEN', `Opened SHORT ${market}: ${fmtUsd(shortSize)} @ $${result.entryPrice.toFixed(2)} | SL: $${shortPosition.stopLoss.toFixed(2)} | TP: $${shortPosition.takeProfit.toFixed(2)}`, shortPosition);

          await sleep(1000);
        }
      }
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

    const timeStopMs = (config.timeStopHours || 24) * 60 * 60 * 1000;

    for (const pos of [...state.positions]) {
      // ── DRIFT SHORT POSITIONS ──
      if (pos.strategy === 'driftShort') {
        // Get current price for the perp market via DexScreener (SOL)
        const solMint = config.mints.SOL;
        const priceData = await getTokenPrice(solMint);
        if (!priceData) continue;

        const currentPrice = priceData.price;
        const { pnl, pnlPercent } = getShortPnl(pos, currentPrice);

        let shouldClose = false;
        let reason = '';

        // Short stop loss: price went UP past SL
        if (currentPrice >= pos.stopLoss) {
          shouldClose = true;
          reason = 'SHORT_STOP_LOSS';
        }
        // Short take profit: price went DOWN past TP
        else if (currentPrice <= pos.takeProfit) {
          shouldClose = true;
          reason = 'SHORT_TAKE_PROFIT';
        }
        // 24h time stop: close if open > 24h and not profitable
        else if (pos.openedAt) {
          const openDuration = Date.now() - new Date(pos.openedAt).getTime();
          if (openDuration > timeStopMs && pnl <= 0) {
            shouldClose = true;
            reason = 'TIME_STOP_24H';
          }
        }

        if (shouldClose) {
          console.log(`[POSITION] Closing short ${pos.market}: ${reason} @ $${currentPrice.toFixed(2)} (entry: $${pos.entryPrice.toFixed(2)}, PnL: ${pnlPercent.toFixed(1)}%)`);

          const result = await closeShort(pos.market, pos.baseAmount);
          if (result.success) {
            const usdcReceived = pos.usdcSpent + pnl;
            closePosition(pos.id, currentPrice, usdcReceived, reason);
          }
        } else {
          console.log(`[POSITION] SHORT ${pos.market}: $${currentPrice.toFixed(2)} (${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(1)}%)`);
        }

        await sleep(500);
        continue;
      }

      // ── REGULAR (LONG) POSITIONS ──
      const priceData = await getTokenPrice(pos.mint);
      if (!priceData) continue;

      const currentPrice = priceData.price;
      let { shouldClose, reason } = checkPosition(pos, currentPrice);

      // 24h time stop for longs too
      if (!shouldClose && pos.openedAt) {
        const openDuration = Date.now() - new Date(pos.openedAt).getTime();
        const longPnl = currentPrice - pos.entryPrice;
        if (openDuration > timeStopMs && longPnl <= 0) {
          shouldClose = true;
          reason = 'TIME_STOP_24H';
        }
      }

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
  if (config.drift?.enabled) {
    console.log(`  Drift shorting: ENABLED | Leverage: ${config.drift.leverage}x | Max shorts: ${config.drift.maxShorts}`);
  }
  console.log(`  Time stop: ${config.timeStopHours || 24}h`);
  console.log('='.repeat(60));

  // Load persisted state
  loadState();

  // Init executor (wallet + RPC)
  initExecutor();

  // Init Drift (if enabled)
  if (config.drift?.enabled) {
    const driftOk = await initDrift();
    console.log(`[BOT] Drift integration: ${driftOk ? 'READY' : 'FAILED'}`);
  }

  // Handle shutdown signals
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    // Ignore EPIPE errors (broken pipe from PM2 cluster mode)
    if (err?.code === 'EPIPE' || err?.message?.includes('EPIPE')) return;
    try { writeAlert('ERROR', `Uncaught exception: ${err.message}`, { stack: err.stack }); } catch (_) {}
  });
  process.on('unhandledRejection', (err) => {
    if (err?.code === 'EPIPE' || err?.message?.includes?.('EPIPE')) return;
    try { writeAlert('ERROR', `Unhandled rejection: ${err?.message || err}`, {}); } catch (_) {}
  });

  // Suppress EPIPE on stdout/stderr (PM2 cluster mode issue)
  process.stdout?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });
  process.stderr?.on?.('error', (err) => { if (err.code !== 'EPIPE') throw err; });

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
