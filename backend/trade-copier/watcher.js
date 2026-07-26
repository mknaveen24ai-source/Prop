'use strict'

require('../loadEnv')

const net = require('net')
const axios = require('axios')
const { v4: uuidv4 } = require('uuid')
const { Pool } = require('pg')
const logger = require('../utils/logger')
const newsService = require('../services/newsService')
const { CONTRACT_SIZES } = require('../constants')
const {
  ensureCopierRuntimeInfrastructure,
  upsertCopierRuntimeStatus
} = require('../utils/copierRuntime')
const {
  ensureCopierV2Infrastructure,
  safeJsonParse
} = require('../utils/copierV2')

const DATABASE_URL = process.env.DATABASE_URL
const MT5_HOST = process.env.MT5_BRIDGE_HOST || '127.0.0.1'
const MT5_PORT = parseInt(process.env.MT5_BRIDGE_PORT || '9999', 10)
const BRIDGE_COMPAT_MODE = String(process.env.COPIER_BRIDGE_COMPAT_MODE || 'strict_ack').trim().toLowerCase()
const COMPAT_AUTO_ACK_MS = parseInt(process.env.COPIER_BRIDGE_AUTO_ACK_MS || '1500', 10)
const EVENT_POLL_MS = parseInt(process.env.COPIER_EVENT_POLL_MS || '500', 10)
const JOB_POLL_MS = parseInt(process.env.COPIER_JOB_POLL_MS || '500', 10)
const BRIDGE_HEARTBEAT_MS = parseInt(process.env.COPIER_BRIDGE_HEARTBEAT_MS || '5000', 10)
const SNAPSHOT_REQUEST_MS = parseInt(process.env.COPIER_SNAPSHOT_REQUEST_MS || '15000', 10)
const RUNTIME_STATUS_MS = parseInt(process.env.COPIER_RUNTIME_STATUS_MS || '5000', 10)
const ACK_TIMEOUT_MS = parseInt(process.env.COPIER_ACK_TIMEOUT_MS || '8000', 10)
const DEAD_LETTER_ALERT_THRESHOLD = parseInt(process.env.COPIER_DLQ_ALERT_THRESHOLD || '10', 10)
const RETRY_DELAYS_SECONDS = [1, 3, 10, 30, 60]
const MARKET_EVENT_TYPES = new Set(['OPEN_MARKET', 'PARTIAL_CLOSE', 'CLOSE_POSITION'])
const ENTRY_FILTER_EVENT_TYPES = new Set(['OPEN_MARKET', 'PLACE_PENDING'])
const SUCCESS_ACK_STATUSES = new Set(['acknowledged', 'accepted', 'ok', 'success', 'filled'])
const RETRY_ACK_STATUSES = new Set(['retry', 'queued', 'timeout', 'bridge_busy', 'temporary_error'])

const pool = new Pool({ connectionString: DATABASE_URL })

// FIX (SECURITY AUDIT): This process had no top-level crash handler — unlike
// server.js and workers/emailWorker.js, an error outside the per-job try/catch
// (e.g. inside one of the setInterval callbacks) would crash the process with
// no logging and no cleanup, relying entirely on an external supervisor to
// notice and restart it. Mirrors server.js's handling: log + exit on an
// uncaught exception (process state is unknown, safest to let a supervisor
// restart cleanly); log-only on unhandled rejections.
process.on('unhandledRejection', (reason) => {
  logger.error('[trade-copier] Unhandled promise rejection:', { error: reason?.message || String(reason), stack: reason?.stack })
})
process.on('uncaughtException', (err) => {
  logger.error('[trade-copier] Uncaught exception:', { error: err.message, stack: err.stack })
  process.exit(1)
})

let socket = null
let socketReady = false
let bridgeHeartbeatAt = null
let lastSnapshotAt = null
let lastError = null
let readBuffer = ''
let deadLetterAlertedCount = 0
const inflightAcks = new Map()

function numeric(value, fallback = null) {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function utcDayCode(date = new Date()) {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getUTCDay()]
}

function utcTimeCode(date = new Date()) {
  const hours = String(date.getUTCHours()).padStart(2, '0')
  const minutes = String(date.getUTCMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function isTimeWithinRange(timeCode, start, end) {
  if (!start || !end) return true
  if (start <= end) return timeCode >= start && timeCode <= end
  return timeCode >= start || timeCode <= end
}

function isWithinSessionFilter(filter = {}) {
  if (!filter.enabled) return true
  const day = utcDayCode()
  if (Array.isArray(filter.days) && filter.days.length > 0 && !filter.days.includes(day)) {
    return false
  }
  return isTimeWithinRange(utcTimeCode(), filter.start_utc, filter.end_utc)
}

function isNewsBlocked(filter = {}) {
  if (!filter.enabled) return false
  const beforeMinutes = Math.max(0, parseInt(filter.before_minutes || 5, 10))
  const afterMinutes = Math.max(0, parseInt(filter.after_minutes || 5, 10))
  const events = newsService.getUpcomingEvents(Math.max(beforeMinutes, afterMinutes, 5) + 5)
  const now = Date.now()
  return events.some((event) => {
    const impact = String(event.impact || '').toLowerCase()
    if (Array.isArray(filter.impact_levels) && filter.impact_levels.length > 0 && !filter.impact_levels.includes(impact)) {
      return false
    }
    const timestamp = Number(event.timestamp || 0)
    return now >= (timestamp - beforeMinutes * 60 * 1000) && now <= (timestamp + afterMinutes * 60 * 1000)
  })
}

function getExpiryDate(eventType, createdAt = new Date()) {
  const ttlMs = MARKET_EVENT_TYPES.has(eventType) ? 10_000 : 5 * 60 * 1000
  return new Date(new Date(createdAt).getTime() + ttlMs)
}

function getRetryDelaySeconds(attemptNo) {
  const index = Math.min(Math.max(attemptNo - 1, 0), RETRY_DELAYS_SECONDS.length - 1)
  return RETRY_DELAYS_SECONDS[index]
}

function normalizeOrderTypeForCopy(orderType, copyMode) {
  const normalized = String(orderType || 'market').trim().toLowerCase()
  if (copyMode !== 'reverse') return normalized
  if (normalized === 'buy_limit') return 'sell_limit'
  if (normalized === 'sell_limit') return 'buy_limit'
  if (normalized === 'buy_stop') return 'sell_stop'
  if (normalized === 'sell_stop') return 'buy_stop'
  return normalized
}

function resolveCopiedDirection(direction, copyMode) {
  const normalized = String(direction || '').trim().toLowerCase()
  if (copyMode !== 'reverse') return normalized
  if (normalized === 'buy') return 'sell'
  if (normalized === 'sell') return 'buy'
  return normalized
}

function resolveStopsForCopy(payload, copyMode) {
  if (copyMode !== 'reverse') {
    return {
      stopLoss: payload.stop_loss ?? null,
      takeProfit: payload.take_profit ?? null
    }
  }
  return {
    stopLoss: payload.take_profit ?? null,
    takeProfit: payload.stop_loss ?? null
  }
}

function getSymbolConstraint(symbolConstraints = {}, symbol) {
  if (!symbolConstraints || typeof symbolConstraints !== 'object') {
    return { minLot: 0.01, lotStep: 0.01 }
  }
  const raw = symbolConstraints[symbol] || symbolConstraints[symbol?.toUpperCase?.()] || {}
  return {
    minLot: numeric(raw.min_lot ?? raw.minLot, 0.01) || 0.01,
    lotStep: numeric(raw.lot_step ?? raw.lotStep, 0.01) || 0.01
  }
}

function roundLotsDown(rawLots, lotStep, minLot) {
  if (!Number.isFinite(rawLots) || rawLots <= 0) return null
  const step = Number.isFinite(lotStep) && lotStep > 0 ? lotStep : 0.01
  const minimum = Number.isFinite(minLot) && minLot > 0 ? minLot : 0.01
  const rounded = Math.floor((rawLots + 1e-12) / step) * step
  if (rounded + 1e-12 < minimum) return null
  return Math.floor(rounded * 1_000_000) / 1_000_000
}

function getContractSize(symbol) {
  return numeric(CONTRACT_SIZES[symbol], 100000) || 100000
}

function computeRequestedLots({ riskMode, follower, masterMeta, payload, constraint }) {
  const masterLots = numeric(payload.lot_size, null)
  if (!Number.isFinite(masterLots) || masterLots <= 0) {
    return { error: 'Invalid master lot size' }
  }

  const minLot = constraint.minLot
  const lotStep = constraint.lotStep
  let rawLots = null

  if (riskMode === 'fixed_lots') {
    rawLots = numeric(follower.fixed_lots, null)
  } else if (riskMode === 'balance_ratio') {
    const followerBalance = numeric(follower.last_balance, null)
    const masterBalance = numeric(masterMeta.current_balance, null)
    if (!Number.isFinite(followerBalance) || !Number.isFinite(masterBalance) || masterBalance <= 0) {
      return { error: 'Missing balance snapshot for balance_ratio sizing' }
    }
    rawLots = masterLots * (followerBalance / masterBalance) * numeric(follower.ratio_multiplier, 1)
  } else if (riskMode === 'equity_ratio') {
    const followerEquity = numeric(follower.last_equity, null)
    const masterEquity = numeric(masterMeta.current_balance, null)
    if (!Number.isFinite(followerEquity) || !Number.isFinite(masterEquity) || masterEquity <= 0) {
      return { error: 'Missing equity snapshot for equity_ratio sizing' }
    }
    rawLots = masterLots * (followerEquity / masterEquity) * numeric(follower.ratio_multiplier, 1)
  } else if (riskMode === 'risk_percent') {
    const followerEquity = numeric(follower.last_equity, null)
    const riskPercent = numeric(follower.risk_percent, null)
    const entryPrice = numeric(payload.pending_price ?? payload.open_price, null)
    const stopLoss = numeric(payload.stop_loss, null)
    if (!Number.isFinite(followerEquity) || !Number.isFinite(riskPercent)) {
      return { error: 'Missing equity snapshot for risk_percent sizing' }
    }
    if (!Number.isFinite(entryPrice) || !Number.isFinite(stopLoss) || Math.abs(entryPrice - stopLoss) < 1e-9) {
      return { error: 'risk_percent sizing requires a valid stop loss' }
    }
    const contractSize = getContractSize(payload.instrument)
    const riskAmount = followerEquity * (riskPercent / 100)
    rawLots = riskAmount / (Math.abs(entryPrice - stopLoss) * contractSize)
  }

  const requestedLots = roundLotsDown(rawLots, lotStep, minLot)
  if (!requestedLots) {
    return { error: 'Calculated lots fall below broker minimum' }
  }

  return { requestedLots }
}

function shouldUseIdentitySymbol(symbolCatalog, symbol) {
  if (!Array.isArray(symbolCatalog) || symbolCatalog.length === 0) return false
  return symbolCatalog.some((item) => String(item || '').toUpperCase() === String(symbol || '').toUpperCase())
}

async function sendFailureWebhook(eventType, payload) {
  try {
    const endpointsResult = await pool.query(
      `SELECT target_url, secret, event_allowlist_json
         FROM copier_alert_endpoints
        WHERE is_enabled = TRUE
          AND endpoint_type = 'webhook'`
    )

    for (const row of endpointsResult.rows) {
      const allowlist = safeJsonParse(row.event_allowlist_json, [])
      if (Array.isArray(allowlist) && allowlist.length > 0 && !allowlist.includes(eventType)) {
        continue
      }
      if (!row.target_url) continue

      axios.post(row.target_url, {
        event_type: eventType,
        occurred_at: new Date().toISOString(),
        payload
      }, {
        timeout: 5000,
        headers: row.secret ? { 'x-copier-secret': row.secret } : undefined
      }).catch(() => {})
    }
  } catch (_) {
    // best effort only
  }
}

async function persistRuntimeStatus() {
  try {
    const metricsResult = await pool.query(
      `SELECT
         COUNT(DISTINCT j.id) FILTER (WHERE j.state IN ('pending', 'retry', 'sent'))::INT AS queue_depth,
         COUNT(DISTINCT j.id) FILTER (WHERE j.state = 'dead')::INT AS dead_letter_count,
         COUNT(DISTINCT j.id) FILTER (WHERE j.acknowledged_at >= NOW() - INTERVAL '1 minute')::INT AS throughput_last_minute,
         COUNT(DISTINCT j.id) FILTER (WHERE j.state = 'retry' AND j.updated_at >= NOW() - INTERVAL '1 hour')::INT AS retry_count_last_hour,
         COUNT(DISTINCT j.id) FILTER (WHERE j.updated_at >= NOW() - INTERVAL '1 hour')::INT AS total_updates_last_hour,
         PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY latency_ms) AS ack_p50_ms,
         PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) AS ack_p95_ms
       FROM copier_jobs j
       LEFT JOIN copier_job_attempts a
         ON a.job_id = j.id
        AND a.delivery_status = 'acknowledged'
        AND a.latency_ms IS NOT NULL`
    )
    const metrics = metricsResult.rows[0] || {}
    const retryRate = Number(metrics.total_updates_last_hour || 0) > 0
      ? Number(metrics.retry_count_last_hour || 0) / Number(metrics.total_updates_last_hour || 1)
      : 0

    await upsertCopierRuntimeStatus(pool, {
      status_key: 'primary',
      runtime_scope: 'shared_worker',
      running: true,
      socket_ready: socketReady,
      ws_connected: false,
      last_heartbeat_at: new Date(),
      queue_depth: Number(metrics.queue_depth || 0),
      mt5_host: MT5_HOST,
      mt5_port: MT5_PORT,
      bridge_heartbeat_at: bridgeHeartbeatAt,
      last_snapshot_at: lastSnapshotAt,
      ack_p50_ms: metrics.ack_p50_ms == null ? null : Math.round(Number(metrics.ack_p50_ms)),
      ack_p95_ms: metrics.ack_p95_ms == null ? null : Math.round(Number(metrics.ack_p95_ms)),
      throughput_last_minute: Number(metrics.throughput_last_minute || 0),
      retry_rate_last_hour: retryRate,
      dead_letter_count: Number(metrics.dead_letter_count || 0),
      last_error: lastError,
      current_config: {
        mode: 'copier_v2',
        bridge_host: MT5_HOST,
        bridge_port: MT5_PORT,
        retry_schedule_seconds: RETRY_DELAYS_SECONDS,
        market_job_ttl_seconds: 10,
        modify_job_ttl_seconds: 300
      }
    })

    if (Number(metrics.dead_letter_count || 0) >= DEAD_LETTER_ALERT_THRESHOLD && Number(metrics.dead_letter_count || 0) !== deadLetterAlertedCount) {
      deadLetterAlertedCount = Number(metrics.dead_letter_count || 0)
      sendFailureWebhook('dead_letter_burst', { dead_letter_count: deadLetterAlertedCount })
    }
  } catch (error) {
    lastError = `[runtime] ${error.message}`
    logger.warn('[copier-worker] runtime status update failed:', { error: error.message })
  }
}

function connectBridge() {
  if (socket) {
    socket.removeAllListeners()
    socket.destroy()
  }

  socket = new net.Socket()
  readBuffer = ''

  socket.connect(MT5_PORT, MT5_HOST, () => {
    socketReady = true
    bridgeHeartbeatAt = new Date()
    lastError = null
    logger.info(`[copier-worker] Connected to MT5 bridge ${MT5_HOST}:${MT5_PORT}`)
  })

  socket.on('data', (chunk) => {
    readBuffer += chunk.toString('utf8')
    let newlineIndex = readBuffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const raw = readBuffer.slice(0, newlineIndex).trim()
      readBuffer = readBuffer.slice(newlineIndex + 1)
      if (raw) {
        handleBridgeLine(raw).catch((error) => {
          lastError = `[bridge-parse] ${error.message}`
          logger.warn('[copier-worker] Failed to handle bridge message:', { error: error.message })
        })
      }
      newlineIndex = readBuffer.indexOf('\n')
    }
  })

  socket.on('close', () => {
    socketReady = false
    lastError = 'MT5 bridge disconnected'
    logger.warn('[copier-worker] MT5 bridge disconnected, reconnecting in 2s')
    setTimeout(connectBridge, 2000)
  })

  socket.on('error', (error) => {
    socketReady = false
    lastError = `[bridge] ${error.message}`
    logger.warn('[copier-worker] MT5 bridge error:', { error: error.message })
  })
}

function sendBridgeCommand(command) {
  if (!socketReady || !socket) return false
  socket.write(`${JSON.stringify(command)}\n`)
  return true
}

async function scheduleCompatibilityAck(command, job) {
  if (BRIDGE_COMPAT_MODE !== 'optimistic_ack') return
  setTimeout(async () => {
    if (!inflightAcks.has(command.correlation_id)) {
      return
    }
    await handleBridgeAck({
      correlation_id: command.correlation_id,
      status: 'acknowledged',
      external_ticket: command.external_ticket || null,
      external_order_id: command.external_order_id || null,
      bridge_timestamp: new Date().toISOString(),
      compatibility_mode: 'optimistic_ack',
      message: 'Synthetic acknowledgement generated for legacy bridge compatibility'
    }).catch((error) => {
      lastError = `[compat-ack] ${error.message}`
      logger.warn('[copier-worker] compatibility ack failed:', { error: error.message, jobId: job.id })
    })
  }, Math.max(250, COMPAT_AUTO_ACK_MS))
}

async function updateFollowerSnapshotFromBridge(message) {
  const followerId = numeric(message.follower_id, null)
  const bridgeTargetKey = message.bridge_target_key ? String(message.bridge_target_key).trim() : null
  if (!followerId && !bridgeTargetKey) return

  const snapshot = {
    balance: numeric(message.balance, null),
    equity: numeric(message.equity, null),
    positions: Array.isArray(message.positions) ? message.positions : [],
    pending_orders: Array.isArray(message.pending_orders) ? message.pending_orders : [],
    symbol_catalog: Array.isArray(message.symbol_catalog) ? message.symbol_catalog : [],
    symbol_constraints: message.symbol_constraints && typeof message.symbol_constraints === 'object' ? message.symbol_constraints : {},
    raw: message
  }

  const identifierClause = followerId ? `id = $1` : `bridge_target_key = $1`
  const identifierValue = followerId || bridgeTargetKey
  const currentFollowerResult = await pool.query(
    `SELECT stats_json FROM copier_followers WHERE ${identifierClause} LIMIT 1`,
    [identifierValue]
  )
  const currentStats = safeJsonParse(currentFollowerResult.rows[0]?.stats_json, {})
  const today = new Date().toISOString().slice(0, 10)
  if (currentStats.day_start_utc !== today || !Number.isFinite(numeric(currentStats.day_start_equity, null))) {
    currentStats.day_start_utc = today
    currentStats.day_start_equity = snapshot.equity
  }
  currentStats.last_snapshot_source = 'bridge'

  await pool.query(
    `UPDATE copier_followers
        SET last_snapshot_json = $2::jsonb,
            symbol_catalog_json = $3::jsonb,
            symbol_constraints_json = $4::jsonb,
            last_balance = $5,
            last_equity = $6,
            last_snapshot_at = NOW(),
            last_heartbeat_at = NOW(),
            stats_json = $7::jsonb,
            updated_at = NOW()
      WHERE ${identifierClause}`,
    [
      identifierValue,
      JSON.stringify(snapshot),
      JSON.stringify(snapshot.symbol_catalog),
      JSON.stringify(snapshot.symbol_constraints),
      snapshot.balance,
      snapshot.equity,
      JSON.stringify(currentStats)
    ]
  )

  lastSnapshotAt = new Date()
  bridgeHeartbeatAt = new Date()
}

async function upsertPositionLinkFromAck(job, command, ack) {
  const currentState = (() => {
    switch (command.event_type) {
      case 'OPEN_MARKET':
        return 'open'
      case 'PLACE_PENDING':
      case 'MODIFY_PENDING':
        return 'pending'
      case 'CANCEL_PENDING':
        return 'cancelled'
      case 'CLOSE_POSITION':
        return 'closed'
      case 'PARTIAL_CLOSE':
        return 'open'
      default:
        return 'open'
    }
  })()

  const externalTicket = ack.external_ticket || ack.ticket || null
  const externalOrderId = ack.external_order_id || ack.order_id || null
  const remainingLots = command.event_type === 'PARTIAL_CLOSE'
    ? numeric(command.remaining_lots, command.requested_lots)
    : numeric(command.requested_lots, null)

  await pool.query(
    `INSERT INTO copier_position_links (
       master_id,
       follower_id,
       master_trade_id,
       follower_external_ticket,
       follower_external_order_id,
       mapped_symbol,
       last_known_lots,
       current_state,
       last_synced_at,
       metadata_json,
       updated_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), $9::jsonb, NOW())
     ON CONFLICT (follower_id, master_trade_id) DO UPDATE SET
       follower_external_ticket = COALESCE(EXCLUDED.follower_external_ticket, copier_position_links.follower_external_ticket),
       follower_external_order_id = COALESCE(EXCLUDED.follower_external_order_id, copier_position_links.follower_external_order_id),
       mapped_symbol = COALESCE(EXCLUDED.mapped_symbol, copier_position_links.mapped_symbol),
       last_known_lots = COALESCE(EXCLUDED.last_known_lots, copier_position_links.last_known_lots),
       current_state = EXCLUDED.current_state,
       last_synced_at = NOW(),
       metadata_json = EXCLUDED.metadata_json,
       updated_at = NOW()`,
    [
      job.master_id,
      job.follower_id,
      job.master_trade_id,
      externalTicket,
      externalOrderId,
      command.mapped_symbol || null,
      remainingLots,
      currentState,
      JSON.stringify({
        bridge_ack: ack,
        command
      })
    ]
  )
}

async function recordJobAttempt(db, jobId, attemptNo, stage, deliveryStatus, message, bridgePayload = {}, responsePayload = {}, latencyMs = null) {
  await db.query(
    `INSERT INTO copier_job_attempts (
       job_id,
       attempt_no,
       stage,
       delivery_status,
       latency_ms,
       bridge_payload_json,
       response_payload_json,
       message
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8)`,
    [
      jobId,
      attemptNo,
      stage,
      deliveryStatus,
      latencyMs,
      JSON.stringify(bridgePayload || {}),
      JSON.stringify(responsePayload || {}),
      message || null
    ]
  )
}

async function finalizeJobState(job, nextState, message, responsePayload = {}, options = {}) {
  const latencyMs = options.sentAt ? Math.max(0, Date.now() - options.sentAt.getTime()) : null
  await pool.query(
    `UPDATE copier_jobs
        SET state = $2,
            last_error = $3,
            dead_reason = CASE WHEN $2 = 'dead' THEN $3 ELSE dead_reason END,
            acknowledged_at = CASE WHEN $2 = 'acknowledged' THEN NOW() ELSE acknowledged_at END,
            ack_payload_json = $4::jsonb,
            updated_at = NOW()
      WHERE id = $1`,
    [job.id, nextState, message || null, JSON.stringify(responsePayload || {})]
  )
  await recordJobAttempt(
    pool,
    job.id,
    Math.max(1, Number(job.attempts_count || 0)),
    options.stage || 'ack',
    nextState === 'acknowledged' ? 'acknowledged' : nextState,
    message,
    job.command_json ? safeJsonParse(job.command_json, {}) : {},
    responsePayload,
    latencyMs
  )
}

async function scheduleRetry(job, message) {
  const attemptsCount = Number(job.attempts_count || 0)
  const expiresAt = job.expires_at ? new Date(job.expires_at) : null
  const expired = expiresAt && expiresAt.getTime() <= Date.now()
  if (expired) {
    await pool.query(
      `UPDATE copier_jobs
          SET state = 'expired',
              last_error = $2,
              dead_reason = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [job.id, message || 'Job expired before acknowledgement']
    )
    await recordJobAttempt(pool, job.id, attemptsCount || 1, 'ack_timeout', 'expired', message)
    return
  }

  if (attemptsCount >= RETRY_DELAYS_SECONDS.length) {
    await pool.query(
      `UPDATE copier_jobs
          SET state = 'dead',
              last_error = $2,
              dead_reason = $2,
              updated_at = NOW()
        WHERE id = $1`,
      [job.id, message || 'Retry budget exhausted']
    )
    await recordJobAttempt(pool, job.id, attemptsCount || 1, 'ack_timeout', 'failed', message)
    sendFailureWebhook('copier_job_dead', {
      follower_id: job.follower_id,
      master_trade_id: job.master_trade_id,
      correlation_id: job.correlation_id,
      reason: message
    })
    return
  }

  const delaySeconds = getRetryDelaySeconds(attemptsCount)
  await pool.query(
    `UPDATE copier_jobs
        SET state = 'retry',
            scheduled_at = NOW() + ($2 || ' seconds')::interval,
            last_error = $3,
            updated_at = NOW()
      WHERE id = $1`,
    [job.id, String(delaySeconds), message || 'Retry scheduled']
  )
  await recordJobAttempt(pool, job.id, attemptsCount || 1, 'ack_timeout', 'retry', message)
}

async function handleBridgeAck(message) {
  const correlationId = String(message.correlation_id || '').trim()
  if (!correlationId) return

  const inflight = inflightAcks.get(correlationId)
  inflightAcks.delete(correlationId)

  const jobResult = await pool.query(
    `SELECT
       j.*,
       e.master_id,
       e.master_trade_id,
       e.event_type
     FROM copier_jobs j
     JOIN copier_events e ON e.id = j.event_id
     WHERE j.correlation_id = $1
     LIMIT 1`,
    [correlationId]
  )
  if (jobResult.rows.length === 0) return

  const job = jobResult.rows[0]
  const command = safeJsonParse(job.command_json, {})
  const ackStatus = (() => {
    const explicit = String(message.status ?? message.result ?? '').trim().toLowerCase()
    if (explicit) return explicit
    if (message.success === true || message.ok === true || message.external_ticket || message.external_order_id || message.ticket || message.order_id) {
      return 'acknowledged'
    }
    if (message.success === false || message.ok === false || message.error || message.error_message || message.error_code) {
      return 'failed'
    }
    return ''
  })()

  if (SUCCESS_ACK_STATUSES.has(ackStatus)) {
    await finalizeJobState(job, 'acknowledged', null, message, {
      stage: 'ack',
      sentAt: inflight?.sentAt || null
    })
    await upsertPositionLinkFromAck(job, command, message)
    if (message.positions || message.pending_orders || message.symbol_catalog) {
      await updateFollowerSnapshotFromBridge({
        ...message,
        follower_id: job.follower_id,
        bridge_target_key: command.bridge_target_key
      })
    } else {
      requestFollowerSnapshot({
        follower_id: job.follower_id,
        bridge_target_key: command.bridge_target_key
      })
    }
    return
  }

  const errorMessage = message.error_message || message.message || 'Bridge rejected copier command'
  if (RETRY_ACK_STATUSES.has(ackStatus)) {
    await scheduleRetry(job, errorMessage)
    return
  }

  await pool.query(
    `UPDATE copier_jobs
        SET state = 'dead',
            last_error = $2,
            dead_reason = $2,
            updated_at = NOW()
      WHERE id = $1`,
    [job.id, errorMessage]
  )
  await recordJobAttempt(pool, job.id, Math.max(1, Number(job.attempts_count || 0)), 'ack', 'failed', errorMessage, command, message, inflight?.sentAt ? Math.max(0, Date.now() - inflight.sentAt.getTime()) : null)
  sendFailureWebhook('copier_job_dead', {
    follower_id: job.follower_id,
    master_trade_id: job.master_trade_id,
    correlation_id: job.correlation_id,
    reason: errorMessage
  })
}

async function handleBridgeLine(rawLine) {
  let message = null
  try {
    message = JSON.parse(rawLine)
  } catch {
    if (/heartbeat/i.test(rawLine)) {
      bridgeHeartbeatAt = new Date()
    }
    return
  }

  if (String(message.type || '').toLowerCase() === 'heartbeat' || String(message.status || '').toLowerCase() === 'heartbeat') {
    bridgeHeartbeatAt = new Date()
    return
  }

  if (String(message.type || '').toLowerCase() === 'snapshot' || message.positions || message.pending_orders || message.symbol_catalog) {
    await updateFollowerSnapshotFromBridge(message)
  }

  if (message.correlation_id) {
    await handleBridgeAck(message)
  }
}

async function resolveMappedSymbol(client, followerId, instrument, symbolCatalog) {
  const mappingResult = await client.query(
    `SELECT follower_symbol
       FROM copier_symbol_mappings
      WHERE follower_id = $1
        AND master_symbol = $2
        AND is_enabled = TRUE
      LIMIT 1`,
    [followerId, instrument]
  )
  if (mappingResult.rows.length > 0) {
    return mappingResult.rows[0].follower_symbol
  }
  if (shouldUseIdentitySymbol(symbolCatalog, instrument)) {
    return instrument
  }
  return null
}

async function resolveLinkedPosition(client, followerId, masterTradeId) {
  const result = await client.query(
    `SELECT *
       FROM copier_position_links
      WHERE follower_id = $1
        AND master_trade_id = $2
      LIMIT 1`,
    [followerId, masterTradeId]
  )
  return result.rows[0] || null
}

function isSymbolAllowed(followerAllowlist, mappingAllowlist, symbol) {
  const preferred = Array.isArray(mappingAllowlist) && mappingAllowlist.length > 0
    ? mappingAllowlist
    : followerAllowlist
  if (!Array.isArray(preferred) || preferred.length === 0) return true
  return preferred.includes(symbol)
}

function buildDeadOrSkipped(state, reason, extra = {}) {
  return {
    state,
    reason,
    command: null,
    expiresAt: extra.expiresAt || null
  }
}

async function buildJobForMapping(client, event, masterMeta, mapping) {
  const payload = safeJsonParse(event.payload_json, {})
  const followerSymbolCatalog = safeJsonParse(mapping.symbol_catalog_json, [])
  const followerSymbolConstraints = safeJsonParse(mapping.symbol_constraints_json, {})
  const followerAllowlist = safeJsonParse(mapping.follower_symbol_allowlist_json, [])
  const mappingAllowlist = safeJsonParse(mapping.mapping_symbol_allowlist_json, [])
  const sessionFilter = safeJsonParse(mapping.session_filter_json, {})
  const newsFilter = safeJsonParse(mapping.news_filter_json, {})
  const allowedAccountTypes = safeJsonParse(mapping.allowed_master_account_types_json, ['phase1', 'phase2', 'phase3', 'funded'])

  if (!Array.isArray(allowedAccountTypes) || !allowedAccountTypes.includes(String(masterMeta.account_type || '').toLowerCase())) {
    return buildDeadOrSkipped('skipped', 'Master account type is not allowed for this follower mapping')
  }

  if (!isSymbolAllowed(followerAllowlist, safeJsonParse(mapping.symbol_allowlist_json, []), payload.instrument)) {
    return buildDeadOrSkipped('skipped', 'Symbol is not enabled for this follower mapping')
  }

  if (ENTRY_FILTER_EVENT_TYPES.has(event.event_type)) {
    if (!isWithinSessionFilter(sessionFilter)) {
      return buildDeadOrSkipped('skipped', 'Follower session filter blocked this entry')
    }
    if (isNewsBlocked(newsFilter)) {
      return buildDeadOrSkipped('skipped', 'Follower news filter blocked this entry')
    }
  }

  if (String(mapping.follower_status || '').toLowerCase() !== 'active') {
    return buildDeadOrSkipped('dead', `Follower is ${mapping.follower_status || 'inactive'}`)
  }

  const mappedSymbol = await resolveMappedSymbol(client, mapping.follower_id, payload.instrument, followerSymbolCatalog)
  if (!mappedSymbol) {
    return buildDeadOrSkipped('dead', 'No symbol mapping available and follower catalog does not confirm identity mapping')
  }

  const copyMode = mapping.copy_mode_override || mapping.follower_copy_mode || 'mirror'
  const copiedDirection = resolveCopiedDirection(payload.direction, copyMode)
  const copiedStops = resolveStopsForCopy(payload, copyMode)
  const constraint = getSymbolConstraint(followerSymbolConstraints, mappedSymbol)
  const lotsResult = computeRequestedLots({
    riskMode: mapping.follower_risk_mode || 'fixed_lots',
    follower: mapping,
    masterMeta,
    payload,
    constraint
  })

  if (lotsResult.error) {
    return buildDeadOrSkipped('dead', lotsResult.error)
  }

  const link = await resolveLinkedPosition(client, mapping.follower_id, event.master_trade_id)
  const correlationId = uuidv4()
  const baseCommand = {
    correlation_id: correlationId,
    follower_id: mapping.follower_id,
    bridge_target_key: mapping.bridge_target_key,
    master_id: event.master_id,
    master_trade_id: event.master_trade_id,
    event_type: event.event_type,
    mapped_symbol: mappedSymbol,
    requested_lots: lotsResult.requestedLots,
    sl: copiedStops.stopLoss,
    tp: copiedStops.takeProfit,
    pending_price: payload.pending_price ?? null,
    slippage_limit_points: mapping.max_slippage_points ?? null,
    copy_mode: copyMode,
    direction: copiedDirection,
    order_type: normalizeOrderTypeForCopy(payload.order_type, copyMode),
    close_ratio: numeric(payload.close_ratio, null),
    remaining_lots: numeric(payload.remaining_lots, null),
    close_reason: payload.close_reason || null
  }

  if (event.event_type === 'MODIFY_POSITION') {
    if (!link?.follower_external_ticket) {
      return buildDeadOrSkipped('dead', 'No linked follower position exists for modify event')
    }
    baseCommand.external_ticket = link.follower_external_ticket
  } else if (event.event_type === 'MODIFY_PENDING' || event.event_type === 'CANCEL_PENDING') {
    if (!link?.follower_external_order_id) {
      return buildDeadOrSkipped('dead', 'No linked follower pending order exists')
    }
    baseCommand.external_order_id = link.follower_external_order_id
  } else if (event.event_type === 'PARTIAL_CLOSE') {
    if (!link?.follower_external_ticket) {
      return buildDeadOrSkipped('dead', 'No linked follower position exists for partial close')
    }
    if (!Number.isFinite(numeric(payload.close_ratio, null)) || payload.close_ratio <= 0) {
      return buildDeadOrSkipped('dead', 'Partial close payload is missing close_ratio')
    }
    baseCommand.external_ticket = link.follower_external_ticket
    baseCommand.requested_lots = roundLotsDown(
      numeric(link.last_known_lots, 0) * numeric(payload.close_ratio, 0),
      constraint.lotStep,
      constraint.minLot
    )
    if (!baseCommand.requested_lots) {
      return buildDeadOrSkipped('dead', 'Partial close lots fall below broker minimum')
    }
  } else if (event.event_type === 'CLOSE_POSITION') {
    baseCommand.external_ticket = payload.external_ticket || link?.follower_external_ticket || null
    if (!baseCommand.external_ticket) {
      return buildDeadOrSkipped('dead', 'No linked follower position exists for close event')
    }
  } else if (event.event_type === 'OPEN_MARKET' && link?.follower_external_order_id) {
    baseCommand.cancel_existing_order_id = link.follower_external_order_id
  }

  return {
    state: 'pending',
    reason: null,
    command: baseCommand,
    expiresAt: getExpiryDate(event.event_type, event.created_at)
  }
}

async function createJobsFromPendingEvents() {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const eventsResult = await client.query(
      `SELECT
         e.*,
         a.account_type,
         a.current_balance
       FROM copier_events e
       JOIN accounts a ON a.id::text = e.master_account_id
       WHERE e.dispatch_state = 'pending'
       ORDER BY e.created_at ASC
       LIMIT 25
       FOR UPDATE SKIP LOCKED`
    )

    for (const event of eventsResult.rows) {
      const mappingsResult = await client.query(
        `SELECT
           mf.id AS mapping_id,
           mf.master_id,
           mf.follower_id,
           mf.is_enabled,
           mf.copy_mode_override,
           mf.allowed_master_account_types_json,
           mf.symbol_allowlist_json AS mapping_symbol_allowlist_json,
           f.display_name,
           f.bridge_target_key,
           f.status AS follower_status,
           f.copy_mode AS follower_copy_mode,
           f.risk_mode AS follower_risk_mode,
            f.fixed_lots,
            f.ratio_multiplier,
            f.risk_percent,
           f.symbol_allowlist_json AS follower_symbol_allowlist_json,
            f.session_filter_json,
            f.news_filter_json,
           f.max_slippage_points,
           f.max_spread_points,
           f.max_daily_loss_amount,
           f.max_daily_loss_pct,
           f.equity_floor_amount,
           f.equity_floor_pct,
           f.symbol_catalog_json,
           f.symbol_constraints_json,
           f.last_snapshot_json,
           f.last_balance,
           f.last_equity,
           f.stats_json
         FROM copier_master_followers mf
         JOIN copier_followers f ON f.id = mf.follower_id
        WHERE mf.master_id = $1
          AND mf.is_enabled = TRUE`,
        [event.master_id]
      )

      for (const mapping of mappingsResult.rows) {
        const plan = await buildJobForMapping(client, event, event, mapping)
        const correlationId = plan.command?.correlation_id || uuidv4()
        const insertResult = await client.query(
          `INSERT INTO copier_jobs (
             event_id,
             follower_id,
             mapping_id,
             correlation_id,
             state,
             scheduled_at,
             expires_at,
             command_json,
             dead_reason,
             last_error
           ) VALUES (
             $1, $2, $3, $4, $5, NOW(), $6, $7::jsonb, $8, $8
           )
           ON CONFLICT DO NOTHING
           RETURNING id, attempts_count`,
          [
            event.id,
            mapping.follower_id,
            mapping.mapping_id,
            correlationId,
            plan.state,
            plan.expiresAt,
            JSON.stringify(plan.command || {}),
            plan.reason
          ]
        )

        if (insertResult.rows.length === 0) {
          continue
        }

        const createdJob = insertResult.rows[0]
        if (plan.state === 'dead' || plan.state === 'skipped') {
          await recordJobAttempt(
            client,
            createdJob.id,
            0,
            'dispatch',
            plan.state === 'dead' ? 'failed' : 'ignored',
            plan.reason,
            plan.command || {},
            {}
          )
          if (plan.state === 'dead') {
            sendFailureWebhook('copier_job_dead', {
              follower_id: mapping.follower_id,
              master_trade_id: event.master_trade_id,
              reason: plan.reason
            })
          }
        }
      }

      await client.query(
        `UPDATE copier_events
            SET dispatch_state = 'dispatched',
                dispatched_at = NOW()
          WHERE id = $1`,
        [event.id]
      )
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    lastError = `[dispatch] ${error.message}`
    logger.error('[copier-worker] dispatch error:', { error: error.message })
  } finally {
    client.release()
  }
}

async function processReadyJobs() {
  if (!socketReady) return

  const client = await pool.connect()
  const commandsToSend = []
  try {
    await client.query('BEGIN')
    const jobsResult = await client.query(
      `SELECT
         j.*,
         e.master_id,
         e.master_trade_id,
         e.event_type
       FROM copier_jobs j
       JOIN copier_events e ON e.id = j.event_id
       WHERE j.state IN ('pending', 'retry')
         AND j.scheduled_at <= NOW()
       ORDER BY j.scheduled_at ASC
       LIMIT 25
       FOR UPDATE SKIP LOCKED`
    )

    for (const job of jobsResult.rows) {
      const expiresAt = job.expires_at ? new Date(job.expires_at) : null
      if (expiresAt && expiresAt.getTime() <= Date.now()) {
        await client.query(
          `UPDATE copier_jobs
              SET state = 'expired',
                  dead_reason = 'Job expired before dispatch',
                  last_error = 'Job expired before dispatch',
                  updated_at = NOW()
            WHERE id = $1`,
          [job.id]
        )
        await recordJobAttempt(client, job.id, Number(job.attempts_count || 0), 'dispatch', 'expired', 'Job expired before dispatch')
        continue
      }

      const nextAttemptNo = Number(job.attempts_count || 0) + 1
      await client.query(
        `UPDATE copier_jobs
            SET state = 'sent',
                attempts_count = $2,
                last_attempt_at = NOW(),
                sent_at = COALESCE(sent_at, NOW()),
                updated_at = NOW()
          WHERE id = $1`,
        [job.id, nextAttemptNo]
      )

      const command = safeJsonParse(job.command_json, {})
      commandsToSend.push({
        job: {
          ...job,
          attempts_count: nextAttemptNo
        },
        command
      })
    }

    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    lastError = `[send-queue] ${error.message}`
    logger.error('[copier-worker] send queue error:', { error: error.message })
  } finally {
    client.release()
  }

  for (const item of commandsToSend) {
    const ok = sendBridgeCommand(item.command)
    if (!ok) {
      await scheduleRetry(item.job, 'Bridge disconnected before command write')
      continue
    }
    const sentAt = new Date()
    inflightAcks.set(item.command.correlation_id, {
      jobId: item.job.id,
      sentAt
    })
    await recordJobAttempt(pool, item.job.id, Number(item.job.attempts_count || 1), 'dispatch', 'sent', null, item.command, {})
    await scheduleCompatibilityAck(item.command, item.job)
  }
}

async function processAckTimeouts() {
  const now = Date.now()
  for (const [correlationId, inflight] of Array.from(inflightAcks.entries())) {
    if (now - inflight.sentAt.getTime() < ACK_TIMEOUT_MS) continue
    inflightAcks.delete(correlationId)

    const jobResult = await pool.query(
      `SELECT
         j.*,
         e.master_trade_id,
         e.event_type
       FROM copier_jobs j
       JOIN copier_events e ON e.id = j.event_id
       WHERE j.correlation_id = $1
       LIMIT 1`,
      [correlationId]
    )
    if (jobResult.rows.length === 0) continue
    await scheduleRetry(jobResult.rows[0], 'Bridge acknowledgement timeout')
  }
}

async function pollFollowerProtections() {
  try {
    const followersResult = await pool.query(
      `SELECT *
         FROM copier_followers
        WHERE status = 'active'
          AND (
            max_daily_loss_amount IS NOT NULL
            OR max_daily_loss_pct IS NOT NULL
            OR equity_floor_amount IS NOT NULL
            OR equity_floor_pct IS NOT NULL
          )`
    )

    const today = new Date().toISOString().slice(0, 10)
    for (const follower of followersResult.rows) {
      const stats = safeJsonParse(follower.stats_json, {})
      const dayStartUtc = String(stats.day_start_utc || '')
      const dayStartEquity = numeric(stats.day_start_equity, numeric(follower.last_equity, null))
      const currentEquity = numeric(follower.last_equity, null)
      if (!Number.isFinite(currentEquity)) continue

      let shouldPause = false
      let reason = null
      if (dayStartUtc === today && Number.isFinite(dayStartEquity)) {
        const lossAmount = dayStartEquity - currentEquity
        const lossPct = dayStartEquity > 0 ? (lossAmount / dayStartEquity) * 100 : 0
        if (Number.isFinite(numeric(follower.max_daily_loss_amount, null)) && lossAmount >= numeric(follower.max_daily_loss_amount, 0)) {
          shouldPause = true
          reason = 'Max daily loss amount breached'
        }
        if (!shouldPause && Number.isFinite(numeric(follower.max_daily_loss_pct, null)) && lossPct >= numeric(follower.max_daily_loss_pct, 0)) {
          shouldPause = true
          reason = 'Max daily loss percentage breached'
        }
      }
      if (!shouldPause && Number.isFinite(numeric(follower.equity_floor_amount, null)) && currentEquity <= numeric(follower.equity_floor_amount, 0)) {
        shouldPause = true
        reason = 'Equity floor amount breached'
      }
      if (!shouldPause && Number.isFinite(numeric(follower.equity_floor_pct, null)) && Number.isFinite(dayStartEquity) && dayStartEquity > 0) {
        const equityPct = (currentEquity / dayStartEquity) * 100
        if (equityPct <= numeric(follower.equity_floor_pct, 0)) {
          shouldPause = true
          reason = 'Equity floor percentage breached'
        }
      }

      if (shouldPause) {
        await pool.query(
          `UPDATE copier_followers
              SET status = 'paused',
                  stats_json = jsonb_set(COALESCE(stats_json, '{}'::jsonb), '{auto_pause_reason}', to_jsonb($2::text), true),
                  updated_at = NOW()
            WHERE id = $1`,
          [follower.id, reason]
        )
        sendFailureWebhook('follower_auto_paused', {
          follower_id: follower.id,
          reason
        })
      }
    }
  } catch (error) {
    lastError = `[protections] ${error.message}`
  }
}

async function sendBridgeHeartbeat() {
  if (!socketReady) return
  sendBridgeCommand({
    correlation_id: uuidv4(),
    event_type: 'HEARTBEAT',
    type: 'HEARTBEAT',
    bridge_timestamp: new Date().toISOString()
  })
}

function requestFollowerSnapshot(follower) {
  if (!socketReady || !follower?.follower_id) return false
  return sendBridgeCommand({
    correlation_id: uuidv4(),
    follower_id: follower.follower_id,
    bridge_target_key: follower.bridge_target_key || null,
    event_type: 'SNAPSHOT_REQUEST',
    type: 'SNAPSHOT_REQUEST'
  })
}

async function requestFollowerSnapshots() {
  if (!socketReady) return
  try {
    const followersResult = await pool.query(
      `SELECT id, bridge_target_key
         FROM copier_followers
        WHERE status IN ('active', 'paused')`
    )
    for (const follower of followersResult.rows) {
      requestFollowerSnapshot({
        follower_id: follower.id,
        bridge_target_key: follower.bridge_target_key
      })
    }
  } catch (error) {
    lastError = `[snapshot-request] ${error.message}`
  }
}

async function bootstrap() {
  await ensureCopierRuntimeInfrastructure(pool)
  await ensureCopierV2Infrastructure(pool)
  newsService.start()
  connectBridge()

  await persistRuntimeStatus()

  setInterval(() => {
    createJobsFromPendingEvents().catch((error) => {
      lastError = `[dispatch-loop] ${error.message}`
    })
  }, EVENT_POLL_MS)

  setInterval(() => {
    processReadyJobs().catch((error) => {
      lastError = `[job-loop] ${error.message}`
    })
  }, JOB_POLL_MS)

  setInterval(() => {
    processAckTimeouts().catch((error) => {
      lastError = `[ack-timeout-loop] ${error.message}`
    })
  }, 1000)

  setInterval(() => {
    sendBridgeHeartbeat().catch((error) => {
      lastError = `[heartbeat-loop] ${error.message}`
    })
  }, BRIDGE_HEARTBEAT_MS)

  setInterval(() => {
    requestFollowerSnapshots().catch((error) => {
      lastError = `[snapshot-loop] ${error.message}`
    })
  }, SNAPSHOT_REQUEST_MS)

  setInterval(() => {
    pollFollowerProtections().catch((error) => {
      lastError = `[protection-loop] ${error.message}`
    })
  }, 5000)

  setInterval(() => {
    persistRuntimeStatus().catch((error) => {
      lastError = `[runtime-loop] ${error.message}`
    })
  }, RUNTIME_STATUS_MS)

  logger.info('[copier-worker] Copier v2 worker started')
  logger.info(`[copier-worker] Bridge compatibility mode: ${BRIDGE_COMPAT_MODE}`)
}

bootstrap().catch((error) => {
  logger.error('[copier-worker] Fatal startup error:', { error: error.message })
  process.exit(1)
})
