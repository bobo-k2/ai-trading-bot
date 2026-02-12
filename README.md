# Solana Momentum Trading Bot

Momentum trading bot for established Solana tokens using Jupiter DEX.

## Quick Start

```bash
npm install
node src/index.js          # Dry-run mode (default)
```

## Configuration

Edit `config.json`:
- `mode`: `"dry-run"` (default) or `"live"`
- `rpc.helius`: Your Helius API endpoint (optional, falls back to public RPC)
- Risk params: position size, SL/TP, kill switch

## Live Mode

```bash
export SOLANA_PRIVATE_KEY="your-base58-private-key"
# Set mode to "live" in config.json
node src/index.js
```

## PM2

```bash
pm2 start ecosystem.config.js
pm2 logs solana-momentum-bot
pm2 stop solana-momentum-bot
```

## Strategy

1. **Scanner** polls DexScreener for trending Solana tokens with >$1M liquidity, >24h age
2. **Signals** scores momentum: volume spikes, buy pressure, price breakouts
3. **Executor** swaps via Jupiter (USDC ↔ token)
4. **Risk Manager** enforces SL (-15%), TP (+30%), max 3 positions, -30% kill switch

## Files

| File | Purpose |
|------|---------|
| `config.json` | All parameters |
| `src/index.js` | Main daemon loop |
| `src/scanner.js` | DexScreener token scanner |
| `src/signals.js` | Signal scoring |
| `src/executor.js` | Jupiter swap execution |
| `src/risk.js` | Risk management |
| `src/state.js` | State persistence |
| `src/alerts.js` | Alert file logging |
| `alerts.log` | JSON-line alert output |
| `state.json` | Persisted bot state |

## Alerts

Alerts written to `alerts.log` as JSON lines:
```json
{"timestamp":"...","type":"TRADE_OPEN","message":"...","data":{...}}
```

Types: `TRADE_OPEN`, `TRADE_CLOSE`, `SIGNAL`, `PORTFOLIO_UPDATE`, `ERROR`, `HEARTBEAT`
