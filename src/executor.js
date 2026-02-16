/**
 * Trade executor - Jupiter swap execution (real + dry-run)
 */
const { Connection, Keypair, VersionedTransaction } = require('@solana/web3.js');
const bs58 = require('bs58');
const config = require('../config.json');
const { safeFetch } = require('./utils');
const { writeAlert } = require('./alerts');

const JUPITER = config.apis.jupiter;
const USDC_MINT = config.mints.USDC;
const USDC_DECIMALS = 6;

let connection = null;
let keypair = null;

/** Initialize connection and wallet */
function initExecutor() {
  const rpcUrl = config.rpc.helius || config.rpc.fallback;
  connection = new Connection(rpcUrl, 'confirmed');
  console.log(`[EXECUTOR] RPC: ${rpcUrl.substring(0, 40)}...`);

  if (config.mode === 'live' && process.env.SOLANA_PRIVATE_KEY) {
    try {
      const decoded = bs58.decode(process.env.SOLANA_PRIVATE_KEY);
      keypair = Keypair.fromSecretKey(decoded);
      console.log(`[EXECUTOR] Wallet loaded: ${keypair.publicKey.toBase58()}`);
    } catch (err) {
      console.error(`[EXECUTOR] Failed to load wallet: ${err.message}`);
      console.log('[EXECUTOR] Falling back to dry-run mode');
    }
  } else {
    console.log(`[EXECUTOR] Mode: ${config.mode} (no wallet needed)`);
  }
}

/**
 * Get a Jupiter quote for swapping USDC -> token
 * @param {string} outputMint - Token mint to buy
 * @param {number} amountUsdc - Amount in USDC
 * @returns {object} Quote data
 */
async function getQuote(outputMint, amountUsdc) {
  const amountLamports = Math.floor(amountUsdc * 10 ** USDC_DECIMALS);
  const url = `${JUPITER}/quote?inputMint=${USDC_MINT}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${config.slippageBps}`;
  return safeFetch(url, {}, 10000);
}

/**
 * Get a Jupiter quote for selling token -> USDC
 * @param {string} inputMint - Token mint to sell
 * @param {string} amount - Amount in token's smallest unit
 * @returns {object} Quote data
 */
async function getSellQuote(inputMint, amount) {
  const url = `${JUPITER}/quote?inputMint=${inputMint}&outputMint=${USDC_MINT}&amount=${amount}&slippageBps=${config.slippageBps}`;
  return safeFetch(url, {}, 10000);
}

/**
 * Execute a buy trade (USDC -> token)
 * @param {string} outputMint - Token to buy
 * @param {number} amountUsdc - USDC to spend
 * @param {string} tokenSymbol - For logging
 * @returns {object} { success, txId, outputAmount, price }
 */
async function executeBuy(outputMint, amountUsdc, tokenSymbol) {
  try {
    const quote = await getQuote(outputMint, amountUsdc);
    if (!quote || !quote.outAmount) {
      throw new Error('No quote available');
    }

    const outputAmount = quote.outAmount;
    const price = amountUsdc / (parseInt(outputAmount) / 10 ** (quote.outputDecimals || 9));

    // DRY-RUN: simulate the trade
    if (config.mode !== 'live' || !keypair) {
      console.log(`[EXECUTOR] DRY-RUN BUY: ${amountUsdc} USDC -> ${tokenSymbol} @ ~$${price.toFixed(6)}`);
      return {
        success: true,
        txId: `dry-run-${Date.now()}`,
        outputAmount,
        price,
        simulated: true
      };
    }

    // LIVE: execute the swap
    const swapBody = {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 1000000,
          priorityLevel: "high"
        }
      }
    };

    const swapData = await safeFetch(`${JUPITER}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapBody)
    }, 30000);

    if (!swapData?.swapTransaction) {
      throw new Error('No swap transaction returned');
    }

    // Deserialize, sign, and send
    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const txId = await connection.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3
    });

    await connection.confirmTransaction(txId, 'confirmed');
    console.log(`[EXECUTOR] LIVE BUY: ${amountUsdc} USDC -> ${tokenSymbol} tx: ${txId}`);

    return { success: true, txId, outputAmount, price, simulated: false };

  } catch (err) {
    writeAlert('ERROR', `Buy failed for ${tokenSymbol}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

/**
 * Execute a sell trade (token -> USDC)
 * @param {string} inputMint - Token to sell
 * @param {string} amount - Raw token amount
 * @param {string} tokenSymbol - For logging
 * @returns {object} { success, txId, usdcReceived }
 */
async function executeSell(inputMint, amount, tokenSymbol) {
  try {
    const quote = await getSellQuote(inputMint, amount);
    if (!quote || !quote.outAmount) {
      throw new Error('No sell quote available');
    }

    const usdcReceived = parseInt(quote.outAmount) / 10 ** USDC_DECIMALS;

    // DRY-RUN
    if (config.mode !== 'live' || !keypair) {
      console.log(`[EXECUTOR] DRY-RUN SELL: ${tokenSymbol} -> ${usdcReceived.toFixed(2)} USDC`);
      return { success: true, txId: `dry-run-${Date.now()}`, usdcReceived, simulated: true };
    }

    // LIVE
    const swapBody = {
      quoteResponse: quote,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true,
      prioritizationFeeLamports: {
        priorityLevelWithMaxLamports: {
          maxLamports: 1000000,
          priorityLevel: "high"
        }
      }
    };

    const swapData = await safeFetch(`${JUPITER}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(swapBody)
    }, 30000);

    if (!swapData?.swapTransaction) throw new Error('No swap transaction returned');

    const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    tx.sign([keypair]);

    const txId = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(txId, 'confirmed');

    console.log(`[EXECUTOR] LIVE SELL: ${tokenSymbol} -> ${usdcReceived.toFixed(2)} USDC tx: ${txId}`);
    return { success: true, txId, usdcReceived, simulated: false };

  } catch (err) {
    writeAlert('ERROR', `Sell failed for ${tokenSymbol}: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = { initExecutor, executeBuy, executeSell, getQuote, getSellQuote };
