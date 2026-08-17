#!/usr/bin/env node
'use strict'
/**
 * Socket fan-out load harness
 * ─────────────────────────────────────────────────────────────────────────────
 * Measures what N concurrently connected traders actually cost the realtime
 * layer. Nothing else in this repo measures the socket path: seed-load-test.js
 * measures the engine tick with `io` set to null, so the entire broadcast cost —
 * the thing that decides how many users can be online at once — has never been
 * on a graph.
 *
 * The number that matters is **bytes/sec the server has to write**, not CPU.
 * `io.emit('price_update', <every instrument>)` sends the same payload to every
 * socket, so the cost is linear in connections and the payload size is the
 * multiplier. Run this before and after any fan-out change and compare
 * `bytes/sec (server → all clients)`.
 *
 * ── Usage ──
 *
 *   node scripts/socket-load-test.js --clients=2000
 *   node scripts/socket-load-test.js --clients=10000 --workers=6 --seconds=120
 *   node scripts/socket-load-test.js --clients=500 --url=https://staging.example.com
 *
 * Options:
 *   --clients=N     sockets to open                  (default 1000)
 *   --workers=N     child processes to spread across (default min(4, cpus-1))
 *   --seconds=N     measurement window after connect (default 60)
 *   --rampMs=N      delay between connections, per worker (default 5)
 *   --url=URL       target                           (default http://localhost:5000)
 *   --keep          leave the seeded users behind
 *
 * ── Why workers ──
 *
 * One Node process cannot honestly measure many thousand socket.io clients: the
 * client-side parsing competes with the server for the same CPU, and the numbers
 * become the harness's limits rather than the server's. Connections are spread
 * across forked workers, and past roughly 3,000 per worker you should be running
 * this from more than one machine. If harness CPU saturates, the latency figures
 * below are the harness's, not the server's — the summary says so explicitly.
 *
 * ── Requirements ──
 *
 * `socket.io-client` (a devDependency). If it is missing, run `npm install`
 * inside backend/.
 *
 * ── Safety ──
 *
 * Seeds real user rows (unable to log in — the password hash is a literal) and
 * deletes them on teardown. It does not create accounts or trades, so it never
 * interacts with the trade engine. Still refuses a non-local DATABASE_URL unless
 * LOAD_TEST_ALLOW_NONLOCAL=1.
 */

require('../loadEnv')

const os = require('os')
const path = require('path')
const jwt = require('jsonwebtoken')
const { fork } = require('child_process')

// ─── Args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { keep: false }
  for (const raw of argv.slice(2)) {
    const [key, value] = raw.replace(/^--/, '').split('=')
    if (value === undefined) args[key] = true
    else args[key] = /^\d+$/.test(value) ? parseInt(value, 10) : value
  }
  return args
}

const args = parseArgs(process.argv)
const CLIENT_COUNT = args.clients || 1000
const WORKER_COUNT = Math.max(1, args.workers || Math.min(4, Math.max(1, os.cpus().length - 1)))
const SECONDS = args.seconds || 60
const RAMP_MS = args.rampMs != null ? args.rampMs : 5
const TARGET_URL = args.url || process.env.SOCKET_LOAD_URL || 'http://localhost:5000'
const RUN_TAG = 'sockettest'

// ─── Stats helpers (shared by parent and worker) ──────────────────────────────
function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, index)]
}

function summarise(label, samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const sum = sorted.reduce((total, value) => total + value, 0)
  return {
    label,
    count: sorted.length,
    mean: +(sum / (sorted.length || 1)).toFixed(2),
    p50: +percentile(sorted, 50).toFixed(2),
    p95: +percentile(sorted, 95).toFixed(2),
    p99: +percentile(sorted, 99).toFixed(2),
    max: +(sorted[sorted.length - 1] || 0).toFixed(2)
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// WORKER
// ═════════════════════════════════════════════════════════════════════════════
async function runWorker() {
  let ioClient
  try {
    ioClient = require('socket.io-client').io
  } catch {
    process.send({ type: 'fatal', error: 'socket.io-client is not installed. Run `npm install` in backend/.' })
    process.exit(1)
  }

  const config = await new Promise((resolve) => {
    process.once('message', resolve)
  })

  const connectMs = []
  const latencyMs = []
  const interArrivalMs = []
  let framesReceived = 0
  let bytesReceived = 0
  let connectFailures = 0
  let disconnects = 0
  let connected = 0
  let lastFrameAt = 0
  let measuring = false

  const sockets = []

  /**
   * Emit-to-receipt latency.
   *
   * Prefers a server emit timestamp (`t`) on the payload, which is what the
   * delta-emit format carries. Falls back to the newest `updated_at` in a full
   * price map, which measures feed-to-client rather than emit-to-client — a
   * larger number that includes feed lag. The summary reports which was used so
   * the two are never silently compared against each other.
   */
  let latencySource = null
  function latencyFor(payload) {
    if (payload && typeof payload.t === 'number') {
      latencySource = 'emit timestamp'
      return Date.now() - payload.t
    }
    if (!payload || typeof payload !== 'object') return null
    let newest = 0
    for (const key of Object.keys(payload)) {
      const at = payload[key]?.updated_at
      if (!at) continue
      const ms = new Date(at).getTime()
      if (Number.isFinite(ms) && ms > newest) newest = ms
    }
    if (newest === 0) return null
    latencySource = 'feed updated_at (includes feed lag)'
    return Date.now() - newest
  }

  for (const { token, userId } of config.credentials) {
    const startedAt = Date.now()
    const socket = ioClient(config.url, {
      transports: ['websocket'],
      auth: { token },
      reconnection: false,
      timeout: 20000
    })
    sockets.push(socket)

    socket.on('connect', () => {
      connectMs.push(Date.now() - startedAt)
      connected++
      socket.emit('join_account', String(userId))
    })
    socket.on('connect_error', () => { connectFailures++ })
    socket.on('disconnect', () => { disconnects++ })

    const onPayload = (payload) => {
      if (!measuring) return
      framesReceived++
      // Approximate: the wire format adds Engine.IO framing on top, so this
      // undercounts slightly. Good enough to compare before/after a change,
      // which is what it is for.
      bytesReceived += JSON.stringify(payload).length
      const now = Date.now()
      if (lastFrameAt > 0) interArrivalMs.push(now - lastFrameAt)
      lastFrameAt = now
      const latency = latencyFor(payload)
      if (latency != null && latency >= 0 && latency < 60000) latencyMs.push(latency)
    }

    socket.on('price_update', onPayload)
    socket.on('equity_update', onPayload)

    if (config.rampMs > 0) await new Promise((resolve) => { setTimeout(resolve, config.rampMs) })
  }

  // Let stragglers finish connecting before the window opens, so ramp-up traffic
  // is not counted as steady state.
  await new Promise((resolve) => { setTimeout(resolve, 3000) })
  measuring = true
  const rssAtStart = process.memoryUsage().rss

  // Event-loop lag on the harness itself. If this is high the latency numbers
  // above are the harness queueing, not the server being slow — which is the
  // single easiest way to misread a load test.
  const lagSamples = []
  let lagLast = process.hrtime.bigint()
  const lagTimer = setInterval(() => {
    const now = process.hrtime.bigint()
    lagSamples.push(Math.max(0, Number(now - lagLast) / 1e6 - 20))
    lagLast = now
  }, 20)

  await new Promise((resolve) => { setTimeout(resolve, config.seconds * 1000) })

  clearInterval(lagTimer)
  const rssAtEnd = process.memoryUsage().rss

  process.send({
    type: 'result',
    connected,
    connectFailures,
    disconnects,
    framesReceived,
    bytesReceived,
    latencySource,
    connectMs,
    latencyMs,
    interArrivalMs,
    lagSamples,
    rssStartMb: +(rssAtStart / 1024 / 1024).toFixed(1),
    rssEndMb: +(rssAtEnd / 1024 / 1024).toFixed(1)
  })

  for (const socket of sockets) socket.close()
  process.exit(0)
}

// ═════════════════════════════════════════════════════════════════════════════
// PARENT
// ═════════════════════════════════════════════════════════════════════════════
function assertSafeTarget(pool) {
  const url = String(process.env.DATABASE_URL || '')
  if (!url) throw new Error('DATABASE_URL is not set (needed to seed the test users)')
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set (needed to mint socket tokens)')
  if (process.env.LOAD_TEST_ALLOW_NONLOCAL === '1') return pool

  const looksLocal = /@(localhost|127\.0\.0\.1|postgres|db)[:/]/.test(url)
  const looksTest = /(test|staging|load)/i.test(url)
  if (!looksLocal && !looksTest) {
    throw new Error(
      'Refusing to run: DATABASE_URL does not look like a local or test database.\n' +
      'This seeds and deletes user rows. Set LOAD_TEST_ALLOW_NONLOCAL=1 only if you are certain.'
    )
  }
  return pool
}

function makeUserId(n) {
  return `50c1e700-0000-4000-8000-${String(n).padStart(12, '0')}`
}

async function seedUsers(pool) {
  process.stdout.write(`Seeding ${CLIENT_COUNT} users...\n`)
  const credentials = []
  const BATCH = 1000

  for (let start = 0; start < CLIENT_COUNT; start += BATCH) {
    const size = Math.min(BATCH, CLIENT_COUNT - start)
    const ids = []
    const emails = []
    for (let i = 0; i < size; i++) {
      const n = start + i
      ids.push(makeUserId(n))
      emails.push(`${RUN_TAG}-${n}@socketload.invalid`)
    }
    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, country, created_at)
       SELECT unnest($1::uuid[]), unnest($2::text[]), 'socketload-no-login', $3, 'XX', NOW()
       ON CONFLICT (id) DO NOTHING`,
      [ids, emails, RUN_TAG]
    )
  }

  // token_version defaults to 1; the handshake only rejects when the token's tv
  // is LOWER than the row's, so reading it back would be wasted queries at 10K.
  for (let n = 0; n < CLIENT_COUNT; n++) {
    const userId = makeUserId(n)
    credentials.push({
      userId,
      token: jwt.sign(
        { userId, email: `${RUN_TAG}-${n}@socketload.invalid`, tv: 1 },
        process.env.JWT_SECRET,
        { expiresIn: '1h' }
      )
    })
  }

  return credentials
}

async function teardownUsers(pool) {
  await pool.query(`DELETE FROM users WHERE email LIKE $1`, [`${RUN_TAG}-%@socketload.invalid`])
}

function printTable(rows) {
  const header = ['metric', 'count', 'mean', 'p50', 'p95', 'p99', 'max']
  const widths = header.map((h) => h.length)
  const data = rows.map((row) => [row.label, row.count, row.mean, row.p50, row.p95, row.p99, row.max].map(String))
  for (const row of data) row.forEach((cell, i) => { widths[i] = Math.max(widths[i], cell.length) })

  const line = (cells) => cells.map((cell, i) => String(cell).padEnd(widths[i])).join('  ')
  process.stdout.write(`\n${line(header)}\n${widths.map((w) => '-'.repeat(w)).join('  ')}\n`)
  for (const row of data) process.stdout.write(`${line(row)}\n`)
}

async function runParent() {
  const pool = require('../db')
  assertSafeTarget(pool)

  let seeded = false
  try {
    const credentials = await seedUsers(pool)
    seeded = true

    const perWorker = Math.ceil(CLIENT_COUNT / WORKER_COUNT)
    process.stdout.write(
      `Connecting ${CLIENT_COUNT} sockets to ${TARGET_URL} ` +
      `across ${WORKER_COUNT} worker(s) (~${perWorker} each)...\n` +
      `Measurement window: ${SECONDS}s after ramp-up.\n`
    )

    const results = await Promise.all(
      Array.from({ length: WORKER_COUNT }, (_, index) => new Promise((resolve, reject) => {
        const child = fork(path.join(__dirname, 'socket-load-test.js'), ['--child'], {
          env: { ...process.env, SOCKET_LOAD_CHILD: '1' }
        })
        child.on('message', (message) => {
          if (message.type === 'fatal') { reject(new Error(message.error)); return }
          if (message.type === 'result') resolve(message)
        })
        child.on('exit', (code) => {
          if (code !== 0) reject(new Error(`worker ${index} exited with code ${code}`))
        })
        child.send({
          url: TARGET_URL,
          seconds: SECONDS,
          rampMs: RAMP_MS,
          credentials: credentials.slice(index * perWorker, (index + 1) * perWorker)
        })
      }))
    )

    // ── Aggregate ────────────────────────────────────────────────────────────
    const totals = results.reduce((acc, r) => ({
      connected: acc.connected + r.connected,
      connectFailures: acc.connectFailures + r.connectFailures,
      disconnects: acc.disconnects + r.disconnects,
      frames: acc.frames + r.framesReceived,
      bytes: acc.bytes + r.bytesReceived,
      rssMb: acc.rssMb + r.rssEndMb
    }), { connected: 0, connectFailures: 0, disconnects: 0, frames: 0, bytes: 0, rssMb: 0 })

    const connectMs = results.flatMap((r) => r.connectMs)
    const latencyMs = results.flatMap((r) => r.latencyMs)
    const interArrivalMs = results.flatMap((r) => r.interArrivalMs)
    const lagSamples = results.flatMap((r) => r.lagSamples)
    const latencySource = results.find((r) => r.latencySource)?.latencySource || 'none available'

    printTable([
      summarise('connect (ms)', connectMs),
      summarise('event latency (ms)', latencyMs),
      summarise('inter-arrival (ms)', interArrivalMs),
      summarise('harness loop lag (ms)', lagSamples)
    ])

    const bytesPerSec = totals.bytes / SECONDS
    const framesPerSec = totals.frames / SECONDS
    const lagP99 = summarise('', lagSamples).p99

    process.stdout.write(`
Sockets requested       ${CLIENT_COUNT}
Sockets connected       ${totals.connected}
Connect failures        ${totals.connectFailures}
Unexpected disconnects  ${totals.disconnects}

Frames received         ${totals.frames}  (${framesPerSec.toFixed(0)}/s across all sockets)
Bytes received          ${(totals.bytes / 1024 / 1024).toFixed(1)} MB
Server -> clients       ${(bytesPerSec / 1024 / 1024).toFixed(2)} MB/s  (${(bytesPerSec * 8 / 1e6).toFixed(0)} Mbps)
Per socket              ${(bytesPerSec / Math.max(1, totals.connected) / 1024).toFixed(2)} KB/s

Latency measured from   ${latencySource}
Harness RSS (all)       ${totals.rssMb.toFixed(0)} MB
`)

    if (totals.connectFailures > 0) {
      process.stdout.write(
        `\nWARNING: ${totals.connectFailures} connection(s) failed. Check the server's file-descriptor\n` +
        'limit (ulimit -n) and nginx worker_connections before reading anything else here.\n'
      )
    }
    if (lagP99 > 50) {
      process.stdout.write(
        `\nWARNING: harness event-loop lag p99 is ${lagP99}ms. The latency figures above are this\n` +
        'process queueing, not the server. Raise --workers or run from more machines.\n'
      )
    }

    process.stdout.write(`
The line to watch is "Server -> clients". Extrapolate it to your target socket
count: that bandwidth has to leave one process per gateway. If it does not fit,
no amount of CPU helps — the payload has to get smaller or go to fewer sockets.
`)
  } finally {
    if (seeded && !args.keep) {
      await teardownUsers(pool).catch((error) => {
        process.stderr.write(`Teardown failed — remove users LIKE '${RUN_TAG}-%': ${error.message}\n`)
      })
    }
    await pool.end()
  }
}

// ─── Entry ────────────────────────────────────────────────────────────────────
if (process.env.SOCKET_LOAD_CHILD === '1') {
  runWorker().catch((error) => {
    process.send?.({ type: 'fatal', error: error.message })
    process.exit(1)
  })
} else {
  runParent().catch((error) => {
    process.stderr.write(`\nSocket load test failed: ${error.message}\n${error.stack}\n`)
    process.exitCode = 1
  })
}
