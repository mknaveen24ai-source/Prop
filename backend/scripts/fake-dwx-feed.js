#!/usr/bin/env node
'use strict'
/**
 * Synthetic DWX market data writer — for load testing only
 * ─────────────────────────────────────────────────────────────────────────────
 * scripts/socket-load-test.js measures what the realtime layer costs per
 * connected trader, and it measures it by listening for `price_update` frames.
 * That means it needs a server that is actually broadcasting, which means a
 * price feed — and the feed is FILE-BASED (MetaTrader writes DWX_Market_Data.txt).
 *
 * Without MT5 running there are no ticks, so the harness measures zero bytes per
 * second and tells you nothing. This writes the same file MT5 would, so the
 * fan-out path can be exercised on a machine with no terminal attached.
 *
 * ── What it is and is not ──
 *
 * It is a way to compare two fan-out configurations on identical hardware —
 * PRICE_BROADCAST_MS=250 against 100, say. The RATIO between two runs is the
 * useful output.
 *
 * It is NOT a substitute for measuring the real deployment. Absolute bytes/sec
 * from a laptop says nothing about a gateway, and these are random walks rather
 * than real market microstructure.
 *
 *   node scripts/fake-dwx-feed.js --file=/tmp/DWX_Market_Data.txt --hz=10
 *
 * Options:
 *   --file=PATH     where to write        (default $DWX_MARKET_DATA_FILE)
 *   --hz=N          ticks per second      (default 10)
 *   --symbols=N     instruments to move per tick (default 3)
 *   --seconds=N     stop after N seconds  (default: run until killed)
 */

require('../loadEnv')

const fs = require('fs')
const path = require('path')
const { INSTRUMENTS } = require('../constants')

function parseArgs(argv) {
  const args = {}
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=')
    args[key] = value === undefined ? true : (/^\d+$/.test(value) ? parseInt(value, 10) : value)
  }
  return args
}

const args = parseArgs(process.argv)
const FILE = args.file || process.env.DWX_MARKET_DATA_FILE
const HZ = Math.max(1, args.hz || 10)
const MOVERS = Math.max(1, args.symbols || 3)
const SECONDS = args.seconds || 0

if (!FILE) {
  console.error('No output file. Pass --file=PATH or set DWX_MARKET_DATA_FILE.')
  process.exit(1)
}

// Plausible starting levels so the numbers look like prices rather than noise.
// Exact values do not matter — only that they move, and that bid < ask.
function seedPrice(symbol) {
  if (/JPY$/.test(symbol)) return 150 + Math.random()
  if (/^XAU/.test(symbol)) return 2000 + Math.random() * 10
  if (/^XAG/.test(symbol)) return 25 + Math.random()
  if (/^(US30|US500|NAS100|DE40|UK100|JP225|HK50|AUS200)/.test(symbol)) return 5000 + Math.random() * 100
  if (/^(USOIL|UKOIL|NGAS)/.test(symbol)) return 75 + Math.random()
  if (/^BTC/.test(symbol)) return 60000 + Math.random() * 100
  if (/^ETH/.test(symbol)) return 3000 + Math.random() * 10
  return 1 + Math.random() * 0.5
}

const state = new Map()
for (const symbol of INSTRUMENTS) {
  const mid = seedPrice(symbol)
  state.set(symbol, mid)
}

function decimalsFor(symbol) {
  return /JPY$/.test(symbol) ? 3 : (state.get(symbol) > 100 ? 2 : 5)
}

function tick() {
  // Only a handful of instruments move per tick, which is what a real feed does
  // and what the delta broadcast is built around. Moving all 45 every time would
  // measure a case that does not occur.
  for (let i = 0; i < MOVERS; i++) {
    const symbol = INSTRUMENTS[Math.floor(Math.random() * INSTRUMENTS.length)]
    const mid = state.get(symbol)
    state.set(symbol, mid * (1 + (Math.random() - 0.5) * 0.0004))
  }

  const payload = {}
  for (const symbol of INSTRUMENTS) {
    const mid = state.get(symbol)
    const decimals = decimalsFor(symbol)
    const halfSpread = mid * 0.00005
    payload[symbol] = {
      bid: Number((mid - halfSpread).toFixed(decimals)),
      ask: Number((mid + halfSpread).toFixed(decimals))
    }
  }

  // Written IN PLACE, deliberately — not write-then-rename.
  //
  // A rename replaces the inode, and priceFeed.js watches the path: it detects
  // the swap, logs "DWX file renamed/replaced, reattaching watcher in 1s" and
  // re-attaches. At any real tick rate the watcher spends its whole life
  // re-attaching and almost no ticks get through, which makes the harness
  // measure a feed outage rather than the fan-out.
  //
  // MT5 truncates and rewrites in place, so this matches it — and the reader
  // already retries past the EBUSY window that creates.
  fs.writeFileSync(FILE, JSON.stringify(payload))
}

fs.mkdirSync(path.dirname(FILE), { recursive: true })
tick()
console.log(`fake DWX feed → ${FILE} (${INSTRUMENTS.length} symbols, ${HZ}Hz, ${MOVERS} movers/tick)`)

const timer = setInterval(tick, Math.round(1000 / HZ))
if (SECONDS > 0) {
  setTimeout(() => { clearInterval(timer); console.log('feed stopped'); process.exit(0) }, SECONDS * 1000)
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { clearInterval(timer); process.exit(0) })
}
