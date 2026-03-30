/**
 * trade-copier/watcher.js
 *
 * Monitors your prop platform for trade events via THREE sources:
 *   1. PostgreSQL polling  (catches everything, 200ms interval)
 *   2. REST API polling    (fallback / cross-check)
 *   3. WebSocket           (real-time push if your platform emits WS events)
 *
 * Sends signals to the MT5 EA bridge over a persistent TCP socket.
 *
 * Run:  node watcher.js
 */

'use strict'

require('dotenv').config()
const { Pool }   = require('pg')
const axios      = require('axios')
const WebSocket  = require('ws')
const net        = require('net')

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG  (set these in .env)
// ─────────────────────────────────────────────────────────────────────────────
const DB_CONN        = process.env.DATABASE_URL              // postgres://...
const API_BASE       = process.env.API_BASE_URL              // http://localhost:5000
const API_TOKEN      = process.env.ADMIN_JWT                 // admin JWT for REST calls
const WS_URL         = process.env.WS_URL || null            // ws://localhost:5000/ws  (optional)
const MT5_HOST       = process.env.MT5_BRIDGE_HOST || '127.0.0.1'
const MT5_PORT       = parseInt(process.env.MT5_BRIDGE_PORT  || '9999')
const POLL_MS        = parseInt(process.env.POLL_MS          || '200')
const API_POLL_MS    = parseInt(process.env.API_POLL_MS      || '1000')
const COPY_MODE      = process.env.COPY_MODE                 || 'mirror'   // 'mirror' | 'reverse'
const LOT_MULTIPLIER = parseFloat(process.env.LOT_MULTIPLIER || '1.0')
const ONLY_FUNDED    = process.env.ONLY_FUNDED !== 'false'                 // default: only funded accounts

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
const pool        = new Pool({ connectionString: DB_CONN })
const seenOpen    = new Set()   // platform trade IDs we've already sent OPEN for
const seenClose   = new Set()   // platform trade IDs we've already sent CLOSE for
let   dbLastPoll  = new Date(Date.now() - 5000)  // start 5s in past to catch in-flight trades
let   mt5Socket   = null
let   socketReady = false
let   copyMode    = COPY_MODE   // can be hot-swapped via admin API
let   lotMult     = LOT_MULTIPLIER
let   copierEnabled = true

// ─────────────────────────────────────────────────────────────────────────────
// MT5 BRIDGE SOCKET
// ─────────────────────────────────────────────────────────────────────────────
function connectToMT5() {
  mt5Socket = new net.Socket()

  mt5Socket.connect(MT5_PORT, MT5_HOST, () => {
    socketReady = true
    console.log(`[MT5 Bridge] Connected to ${MT5_HOST}:${MT5_PORT}`)
  })

  mt5Socket.on('data', (data) => {
    // MT5 EA can send ACK messages back
    const msg = data.toString().trim()
    if (msg) console.log(`[MT5 ACK] ${msg}`)
  })

  mt5Socket.on('close', () => {
    socketReady = false
    console.warn('[MT5 Bridge] Disconnected — reconnecting in 2s...')
    setTimeout(connectToMT5, 2000)
  })

  mt5Socket.on('error', (err) => {
    socketReady = false
    console.error('[MT5 Bridge] Error:', err.message)
  })
}

/**
 * Send a signal to MT5. Queues if socket isn't ready yet.
 */
const pendingQueue = []
function sendSignal(signal) {
  if (!copierEnabled) return

  signal.mode       = copyMode
  signal.lot_mult   = lotMult
  signal.ts         = Date.now()

  const line = JSON.stringify(signal) + '\n'

  if (socketReady && mt5Socket) {
    mt5Socket.write(line)
    logSignal(signal)
  } else {
    pendingQueue.push(line)
    console.warn(`[Queue] Socket not ready — queued signal (queue size: ${pendingQueue.length})`)
  }
}

// Flush queue once socket reconnects
setInterval(() => {
  if (!copierEnabled) return
  if (socketReady && mt5Socket && pendingQueue.length > 0) {
    console.log(`[Queue] Flushing ${pendingQueue.length} pending signals`)
    while (pendingQueue.length > 0) {
      mt5Socket.write(pendingQueue.shift())
    }
  }
}, 500)

function logSignal(sig) {
  const dir   = sig.action === 'OPEN' ? `${sig.direction?.toUpperCase()} ${sig.lots}L` : ''
  const price = sig.action === 'OPEN' ? `@ ${sig.open_price}` : ''
  const mode  = sig.action === 'OPEN' ? `[${sig.mode}]` : ''
  console.log(`[Signal] ${sig.action} ${sig.symbol || ''} ${dir} ${price} ${mode} ticket#${sig.ticket}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 1: POSTGRESQL POLLING (primary, fastest)
// ─────────────────────────────────────────────────────────────────────────────
async function pollDatabase() {
  if (!copierEnabled) return
  const now = new Date()

  try {
    // ── New OPEN trades ──
    const accountFilter = ONLY_FUNDED ? `AND a.account_type = 'funded'` : ''
    const opened = await pool.query(`
      SELECT t.id, t.instrument, t.direction, t.lot_size,
             t.open_price, t.stop_loss, t.take_profit,
             t.open_time, a.account_type, a.account_size
      FROM   trades t
      JOIN   accounts a ON a.id = t.account_id
      WHERE  t.status    = 'open'
        AND  t.open_time >= $1
        ${accountFilter}
      ORDER  BY t.open_time ASC
    `, [dbLastPoll])

    for (const t of opened.rows) {
      if (seenOpen.has(t.id)) continue
      seenOpen.add(t.id)
      sendSignal({
        action:     'OPEN',
        ticket:     t.id,
        symbol:     normaliseSymbol(t.instrument),
        direction:  t.direction,
        lots:       parseFloat(t.lot_size),
        sl:         t.stop_loss    ? parseFloat(t.stop_loss)    : 0,
        tp:         t.take_profit  ? parseFloat(t.take_profit)  : 0,
        open_price: parseFloat(t.open_price),
        source:     'db'
      })
    }

    // ── New CLOSE trades ──
    const closed = await pool.query(`
      SELECT t.id, t.instrument, t.close_price, t.close_time
      FROM   trades t
      WHERE  t.status     = 'closed'
        AND  t.close_time >= $1
      ORDER  BY t.close_time ASC
    `, [dbLastPoll])

    for (const t of closed.rows) {
      if (seenClose.has(t.id)) continue
      if (!seenOpen.has(t.id)) continue   // never copied the open — skip
      seenClose.add(t.id)
      sendSignal({
        action:      'CLOSE',
        ticket:      t.id,
        symbol:      normaliseSymbol(t.instrument),
        close_price: t.close_price ? parseFloat(t.close_price) : 0,
        source:      'db'
      })
    }

    dbLastPoll = now
  } catch (err) {
    console.error('[DB Poll] Error:', err.message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 2: REST API POLLING (cross-check / redundancy)
// ─────────────────────────────────────────────────────────────────────────────
let apiLastCheck = new Date(Date.now() - 5000)

async function pollRestApi() {
  if (!copierEnabled || !API_BASE || !API_TOKEN) return

  try {
    const headers = { Authorization: `Bearer ${API_TOKEN}` }

    const { data: tradesData } = await axios
      .get(`${API_BASE}/api/admin/copier/open-trades`, { headers })
      .catch(() => ({ data: [] }))

    const trades = Array.isArray(tradesData) ? tradesData : []
    for (const t of trades) {
      if (ONLY_FUNDED && t.account_type !== 'funded') continue
      if (seenOpen.has(t.id)) continue
      if (new Date(t.open_time) < apiLastCheck) continue

      seenOpen.add(t.id)
      sendSignal({
        action:     'OPEN',
        ticket:     t.id,
        symbol:     normaliseSymbol(t.instrument),
        direction:  t.direction,
        lots:       parseFloat(t.lot_size),
        sl:         t.stop_loss   ? parseFloat(t.stop_loss)   : 0,
        tp:         t.take_profit ? parseFloat(t.take_profit) : 0,
        open_price: parseFloat(t.open_price),
        source:     'api'
      })
    }

    apiLastCheck = new Date()
  } catch (err) {
    console.error('[API Poll] Error:', err.message)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SOURCE 3: WEBSOCKET (real-time, lowest latency)
// ─────────────────────────────────────────────────────────────────────────────
function connectWebSocket() {
  if (!WS_URL) return

  const ws = new WebSocket(WS_URL, {
    headers: API_TOKEN ? { Authorization: `Bearer ${API_TOKEN}` } : {}
  })

  ws.on('open', () => {
    console.log('[WS] Connected to platform WebSocket')
    // Subscribe to trade events if your platform uses subscription model
    ws.send(JSON.stringify({ type: 'subscribe', channel: 'trades' }))
  })

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString())

      // Adapt to whatever event shape your platform WS emits
      if (msg.type === 'trade_opened' || msg.event === 'TRADE_OPEN') {
        const t = msg.data || msg.trade || msg
        if (seenOpen.has(t.id)) return
        seenOpen.add(t.id)
        sendSignal({
          action:     'OPEN',
          ticket:     t.id,
          symbol:     normaliseSymbol(t.instrument),
          direction:  t.direction,
          lots:       parseFloat(t.lot_size),
          sl:         t.stop_loss   ? parseFloat(t.stop_loss)   : 0,
          tp:         t.take_profit ? parseFloat(t.take_profit) : 0,
          open_price: parseFloat(t.open_price),
          source:     'ws'
        })
      }

      if (msg.type === 'trade_closed' || msg.event === 'TRADE_CLOSE') {
        const t = msg.data || msg.trade || msg
        if (seenClose.has(t.id)) return
        if (!seenOpen.has(t.id)) return
        seenClose.add(t.id)
        sendSignal({
          action:      'CLOSE',
          ticket:      t.id,
          symbol:      normaliseSymbol(t.instrument),
          close_price: t.close_price ? parseFloat(t.close_price) : 0,
          source:      'ws'
        })
      }
    } catch (err) {
      console.error('[WS] Parse error:', err.message)
    }
  })

  ws.on('close', () => {
    console.warn('[WS] Disconnected — reconnecting in 3s...')
    setTimeout(connectWebSocket, 3000)
  })

  ws.on('error', (err) => {
    console.error('[WS] Error:', err.message)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// HOT CONFIG — admin can change mode without restarting
// ─────────────────────────────────────────────────────────────────────────────
async function watchConfig() {
  try {
    const r = await pool.query(`
      SELECT key, value FROM platform_settings
      WHERE key IN ('copier_enabled', 'copier_mode', 'copier_lot_multiplier')
    `)
    for (const row of r.rows) {
      if (row.key === 'copier_enabled') {
        const nextEnabled = row.value !== 'false'
        if (nextEnabled !== copierEnabled) {
          copierEnabled = nextEnabled
          if (!copierEnabled && pendingQueue.length > 0) pendingQueue.length = 0
          console.log(`[Config] Copier ${copierEnabled ? 'ENABLED' : 'DISABLED'} via admin panel`)
        }
      }
      if (row.key === 'copier_mode' && row.value !== copyMode) {
        console.log(`[Config] Mode changed: ${copyMode} -> ${row.value}`)
        copyMode = row.value
      }
      if (row.key === 'copier_lot_multiplier' && parseFloat(row.value) !== lotMult) {
        console.log(`[Config] Lot multiplier changed: ${lotMult} -> ${row.value}`)
        lotMult = parseFloat(row.value)
      }
    }
  } catch (_) {}
}
// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

// Normalise your platform's instrument names to MT5 symbol names
function normaliseSymbol(instrument) {
  const map = {
    'EURUSD': 'EURUSD',
    'GBPUSD': 'GBPUSD',
    'XAUUSD': 'XAUUSD',   // Gold
    'XAGUSD': 'XAGUSD',   // Silver
    // Add more mappings as needed
  }
  return map[instrument] || instrument
}

// ─────────────────────────────────────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════')
console.log('  Trade Copier — starting up')
console.log(`  Mode: ${copyMode} | Lot mult: ${lotMult}x`)
console.log(`  DB polling:  every ${POLL_MS}ms`)
console.log(`  API polling: every ${API_POLL_MS}ms`)
console.log(`  WS:          ${WS_URL || 'disabled'}`)
console.log(`  MT5 bridge:  ${MT5_HOST}:${MT5_PORT}`)
console.log('═══════════════════════════════════════════════')

connectToMT5()
connectWebSocket()
watchConfig().catch(() => {})

setInterval(pollDatabase,  POLL_MS)
setInterval(pollRestApi,   API_POLL_MS)
setInterval(watchConfig,   5000)   // check for config changes every 5s

process.on('SIGINT', () => {
  console.log('\n[Copier] Shutting down gracefully...')
  if (mt5Socket) mt5Socket.destroy()
  pool.end()
  process.exit(0)
})

