/**
 * Alert logging - writes JSON lines to alerts.log file
 * With log rotation (max 5MB, keeps 1 backup) and error loop protection
 */
const fs = require('fs');
const path = require('path');
const config = require('../config.json');

const ALERT_TYPES = ['TRADE_OPEN', 'TRADE_CLOSE', 'SIGNAL', 'PORTFOLIO_UPDATE', 'ERROR', 'HEARTBEAT',
                     'GRID_SETUP', 'GRID_BUY', 'GRID_SELL', 'GRID_STATUS'];

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB
const MAX_BACKUPS = 1;
let _writing = false; // Prevent recursive write loops
let _lastRotateCheck = 0;

/**
 * Rotate log file if it exceeds MAX_LOG_SIZE
 */
function rotateIfNeeded() {
  const now = Date.now();
  // Only check every 60 seconds to avoid stat() spam
  if (now - _lastRotateCheck < 60000) return;
  _lastRotateCheck = now;

  try {
    const stats = fs.statSync(config.alertsFile);
    if (stats.size >= MAX_LOG_SIZE) {
      const backup = config.alertsFile + '.1';
      // Remove old backup
      try { fs.unlinkSync(backup); } catch (_) {}
      // Rotate current to backup
      fs.renameSync(config.alertsFile, backup);
    }
  } catch (_) {
    // File doesn't exist yet, that's fine
  }
}

/**
 * Write an alert to the alerts log file
 * @param {string} type - Alert type
 * @param {string} message - Human-readable message
 * @param {object} data - Additional data
 */
function writeAlert(type, message, data = {}) {
  // Prevent recursive error loops (writeAlert -> error -> writeAlert -> ...)
  if (_writing) return;
  _writing = true;

  try {
    rotateIfNeeded();

    const alert = {
      timestamp: new Date().toISOString(),
      type,
      message,
      data
    };

    const line = JSON.stringify(alert) + '\n';

    try {
      fs.appendFileSync(config.alertsFile, line);
    } catch (err) {
      // Silently fail on write errors — do NOT console.error to avoid EPIPE loops
    }

    // Log to console (wrapped to prevent EPIPE cascade)
    const emoji = {
      TRADE_OPEN: '🟢', TRADE_CLOSE: '🔴', SIGNAL: '📡',
      PORTFOLIO_UPDATE: '📊', ERROR: '❌', HEARTBEAT: '💓',
      GRID_SETUP: '📐', GRID_BUY: '🟩', GRID_SELL: '🟥', GRID_STATUS: '📊'
    };
    try {
      console.log(`${emoji[type] || '📋'} [${type}] ${message}`);
    } catch (_) {
      // EPIPE or other console error — swallow it
    }
  } finally {
    _writing = false;
  }
}

module.exports = { writeAlert, ALERT_TYPES };
