const test = require('node:test')
const assert = require('node:assert/strict')
const express = require('express')
const request = require('supertest')
require('../loadEnv')
const pool = require('../db')
const logger = require('../utils/logger')
const {
  requestContextMiddleware,
  getRequestId,
  runWithContext,
  normalizeIncomingId,
  MAX_INBOUND_ID_LENGTH
} = require('../utils/requestContext')
const prometheusMetrics = require('../utils/prometheusMetrics')
const { getSystemHealth, STATUS } = require('../utils/systemHealth')
const { getSlowQueryThreshold, setSlowQueryThreshold } = require('../utils/performance')

// ─── Request context ─────────────────────────────────────────────────────────

test('a request without an id gets one, echoed on X-Request-ID', async () => {
  const app = express()
  app.use(requestContextMiddleware)
  app.get('/', (req, res) => res.json({ seen: req.requestId }))

  const res = await request(app).get('/')

  assert.ok(res.headers['x-request-id'])
  assert.equal(res.body.seen, res.headers['x-request-id'])
})

test('an inbound X-Request-ID is preserved so a trace survives a proxy hop', async () => {
  const app = express()
  app.use(requestContextMiddleware)
  app.get('/', (req, res) => res.json({ seen: req.requestId }))

  const res = await request(app).get('/').set('X-Request-ID', 'edge-abc-123')

  assert.equal(res.body.seen, 'edge-abc-123')
  assert.equal(res.headers['x-request-id'], 'edge-abc-123')
})

test('a hostile inbound id is rejected rather than echoed into every log line', async () => {
  const app = express()
  app.use(requestContextMiddleware)
  app.get('/', (req, res) => res.json({ seen: req.requestId }))

  const res = await request(app).get('/').set('X-Request-ID', 'has spaces and <script>')

  assert.notEqual(res.body.seen, 'has spaces and <script>')
  assert.match(res.body.seen, /^[0-9a-f-]{36}$/, 'falls back to a generated uuid')
})

test('normalizeIncomingId caps length and rejects unsafe characters', () => {
  assert.equal(normalizeIncomingId('  abc-123  '), 'abc-123')
  assert.equal(normalizeIncomingId('a'.repeat(MAX_INBOUND_ID_LENGTH + 50)).length, MAX_INBOUND_ID_LENGTH)
  assert.equal(normalizeIncomingId('bad id'), null)
  assert.equal(normalizeIncomingId(''), null)
  assert.equal(normalizeIncomingId(undefined), null)
})

test('the id survives an await, which is the whole point of the async store', async () => {
  await runWithContext({ requestId: 'ctx-1' }, async () => {
    assert.equal(getRequestId(), 'ctx-1')
    await new Promise((resolve) => { setTimeout(resolve, 5) })
    assert.equal(getRequestId(), 'ctx-1', 'lost across an await')
  })
})

test('reading the id outside a request returns undefined instead of throwing', () => {
  // The engines, the email worker and startup all log from outside a request.
  assert.equal(getRequestId(), undefined)
})

test('the logger stamps the active request id onto its metadata', () => {
  const seen = []
  const original = logger.transports[0].log
  // utils/logger.js sets `silent: true` under test so a failing suite is not
  // buried in log output. winston short-circuits on silent BEFORE reaching any
  // transport, so this capture saw nothing and the assertion below could never
  // pass. Lift it for exactly this test, and put it back in the finally.
  const wasSilent = logger.silent
  logger.silent = false
  logger.transports[0].log = function (info, next) { seen.push(info); if (next) next() }

  try {
    runWithContext({ requestId: 'log-trace-9' }, () => {
      logger.info('hello from a request')
    })
    logger.info('hello from outside a request')
  } finally {
    logger.transports[0].log = original
    logger.silent = wasSilent
  }

  const inside = seen.find((i) => String(i.message).includes('from a request'))
  const outside = seen.find((i) => String(i.message).includes('outside a request'))
  assert.equal(inside?.requestId, 'log-trace-9')
  assert.equal(outside?.requestId, undefined)
})

// ─── Prometheus ──────────────────────────────────────────────────────────────

test('the exporter renders text-format metrics', async () => {
  const text = await prometheusMetrics.getMetricsText()
  assert.match(text, /propfirm_db_pool_connections_total/)
  assert.match(text, /propfirm_open_trades/)
  assert.match(prometheusMetrics.contentType, /text\/plain/)
})

test('request metrics are labelled by matched route, not by raw URL', async () => {
  // Labelling by URL would mint one time series per account id.
  const app = express()
  app.use(prometheusMetrics.metricsMiddleware)
  app.get('/accounts/:id', (_req, res) => res.json({ ok: true }))

  await request(app).get('/accounts/12345')
  await request(app).get('/accounts/67890')

  const text = await prometheusMetrics.getMetricsText()
  assert.match(text, /route="\/accounts\/:id"/)
  assert.equal(/route="\/accounts\/12345"/.test(text), false)
})

test('unmatched requests collapse into a single series', async () => {
  const app = express()
  app.use(prometheusMetrics.metricsMiddleware)
  app.get('/known', (_req, res) => res.json({ ok: true }))

  await request(app).get('/nope-a')
  await request(app).get('/nope-b')

  const text = await prometheusMetrics.getMetricsText()
  assert.match(text, /route="unmatched"/)
})

test('recordEngineTick never throws on bad input', () => {
  // Metrics must not be able to break a trade engine tick.
  assert.doesNotThrow(() => prometheusMetrics.recordEngineTick('price_tick', undefined))
  assert.doesNotThrow(() => prometheusMetrics.recordEngineTick(null, NaN))
  prometheusMetrics.recordEngineTick('price_tick', 11.5)
})

// ─── Slow query threshold ────────────────────────────────────────────────────

test('the slow query threshold is adjustable and rejects nonsense', () => {
  const original = getSlowQueryThreshold()
  try {
    setSlowQueryThreshold(750)
    assert.equal(getSlowQueryThreshold(), 750)
    setSlowQueryThreshold(0)
    assert.equal(getSlowQueryThreshold(), 750, 'zero must not disable slow-query logging')
    setSlowQueryThreshold('nonsense')
    assert.equal(getSlowQueryThreshold(), 750)
  } finally {
    setSlowQueryThreshold(original)
  }
})

// ─── System health ───────────────────────────────────────────────────────────

function installHealthPoolMock({ failPing = false, emailRows = {} } = {}) {
  pool.query = async (sql) => {
    if (failPing && /SELECT 1/.test(sql)) throw new Error('pool exhausted')
    if (/FROM email_jobs/.test(sql) && /status = 'dead'/.test(sql)) {
      return { rows: [{ dead_count: 0, dead_last_24h: 0, oldest_dead: null, latest_dead: null }] }
    }
    if (/FROM email_jobs/.test(sql)) {
      return { rows: [{ pending: 0, retrying: 0, sending: 0, last_sent_at: null, ...emailRows }] }
    }
    return { rows: [] }
  }
}

test('the health snapshot reports every subsystem', async () => {
  installHealthPoolMock()

  const health = await getSystemHealth()

  assert.ok(health.generatedAt)
  for (const key of ['database', 'redis', 'priceFeed', 'tradeEngine', 'emailQueue', 'websocket', 'process']) {
    assert.ok(health.sections[key], `missing section: ${key}`)
    assert.ok(health.sections[key].status, `section ${key} has no status`)
  }
})

test('a failing database ping surfaces as an error, not a healthy pool', async () => {
  installHealthPoolMock({ failPing: true })

  const health = await getSystemHealth()

  assert.equal(health.sections.database.status, STATUS.ERROR)
  assert.equal(health.status, STATUS.ERROR, 'the roll-up must not look healthier than its parts')
})

test('dead-lettered email in the last day degrades the email section', async () => {
  pool.query = async (sql) => {
    if (/status = 'dead'/.test(sql)) {
      return { rows: [{ dead_count: 40, dead_last_24h: 40, oldest_dead: new Date(), latest_dead: new Date() }] }
    }
    if (/FROM email_jobs/.test(sql)) {
      return { rows: [{ pending: 0, retrying: 0, sending: 0, last_sent_at: null }] }
    }
    return { rows: [] }
  }

  const health = await getSystemHealth()

  assert.equal(health.sections.emailQueue.status, STATUS.ERROR)
  assert.equal(health.sections.emailQueue.dead_last_24h, 40)
})

test('one broken subsystem does not take the whole snapshot down', async () => {
  // A health endpoint that 500s is useless exactly when it is needed.
  pool.query = async () => { throw new Error('database is gone') }

  const health = await getSystemHealth()

  assert.equal(health.status, STATUS.ERROR)
  assert.ok(health.sections.process.status, 'process section still renders without the database')
  assert.ok(health.sections.process.uptimeSeconds >= 0)
})
