/**
 * Utility helpers
 */
const fetch = require('node-fetch');

/** Sleep for ms */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Safe fetch with timeout and error handling */
async function safeFetch(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Fetch timeout: ${url}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Format USD amount */
function fmtUsd(n) { return `$${Number(n).toFixed(2)}`; }

/** Percentage change between two values */
function pctChange(from, to) { return ((to - from) / from) * 100; }

/** Truncate token address for display */
function shortAddr(addr) { return addr ? `${addr.slice(0, 4)}...${addr.slice(-4)}` : '???'; }

/** Current unix timestamp in seconds */
function nowSec() { return Math.floor(Date.now() / 1000); }

module.exports = { sleep, safeFetch, fmtUsd, pctChange, shortAddr, nowSec };
