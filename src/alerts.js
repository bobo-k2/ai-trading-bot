/**
 * Alert logging - writes JSON lines to alerts.log file
 */
const fs = require('fs');
const config = require('../config.json');

const ALERT_TYPES = ['TRADE_OPEN', 'TRADE_CLOSE', 'SIGNAL', 'PORTFOLIO_UPDATE', 'ERROR', 'HEARTBEAT'];

/**
 * Write an alert to the alerts log file
 * @param {string} type - Alert type
 * @param {string} message - Human-readable message
 * @param {object} data - Additional data
 */
function writeAlert(type, message, data = {}) {
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
    console.error(`[ALERT] Failed to write alert: ${err.message}`);
  }

  // Also log to console
  const emoji = {
    TRADE_OPEN: '🟢', TRADE_CLOSE: '🔴', SIGNAL: '📡',
    PORTFOLIO_UPDATE: '📊', ERROR: '❌', HEARTBEAT: '💓'
  };
  console.log(`${emoji[type] || '📋'} [${type}] ${message}`);
}

module.exports = { writeAlert, ALERT_TYPES };
