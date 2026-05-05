'use strict'

async function ensureCopierRuntimeInfrastructure(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_runtime_status (
      status_key            TEXT PRIMARY KEY,
      running               BOOLEAN NOT NULL DEFAULT FALSE,
      socket_ready          BOOLEAN NOT NULL DEFAULT FALSE,
      ws_connected          BOOLEAN NOT NULL DEFAULT FALSE,
      last_heartbeat_at     TIMESTAMPTZ,
      last_db_poll_at       TIMESTAMPTZ,
      last_api_poll_at      TIMESTAMPTZ,
      last_signal_sent_at   TIMESTAMPTZ,
      queue_depth           INTEGER NOT NULL DEFAULT 0,
      mt5_host              TEXT,
      mt5_port              INTEGER,
      last_error            TEXT,
      current_config        JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    INSERT INTO copier_runtime_status (status_key)
    VALUES ('primary')
    ON CONFLICT (status_key) DO NOTHING
  `)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS copier_signal_logs (
      id                 BIGSERIAL PRIMARY KEY,
      platform_trade_id  BIGINT,
      instrument         TEXT,
      direction          TEXT,
      account_type       TEXT,
      policy_applied     TEXT,
      action             TEXT NOT NULL,
      source             TEXT,
      delivery_status    TEXT NOT NULL,
      message            TEXT,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS copier_signal_logs_trade_idx
    ON copier_signal_logs(platform_trade_id, action, delivery_status, created_at DESC)
  `)

  await pool.query(`
    CREATE INDEX IF NOT EXISTS copier_signal_logs_created_idx
    ON copier_signal_logs(created_at DESC)
  `)
}

async function upsertCopierRuntimeStatus(pool, status = {}) {
  const runtime = {
    status_key: status.status_key || 'primary',
    running: Boolean(status.running),
    socket_ready: Boolean(status.socket_ready),
    ws_connected: Boolean(status.ws_connected),
    runtime_scope: status.runtime_scope || 'shared_worker',
    tenant_id: status.tenant_id ?? null,
    follower_id: status.follower_id ?? null,
    last_heartbeat_at: status.last_heartbeat_at || null,
    last_db_poll_at: status.last_db_poll_at || null,
    last_api_poll_at: status.last_api_poll_at || null,
    last_signal_sent_at: status.last_signal_sent_at || null,
    queue_depth: Number.isFinite(Number(status.queue_depth)) ? Number(status.queue_depth) : 0,
    mt5_host: status.mt5_host || null,
    mt5_port: Number.isFinite(Number(status.mt5_port)) ? Number(status.mt5_port) : null,
    bridge_heartbeat_at: status.bridge_heartbeat_at || null,
    last_snapshot_at: status.last_snapshot_at || null,
    ack_p50_ms: Number.isFinite(Number(status.ack_p50_ms)) ? Number(status.ack_p50_ms) : null,
    ack_p95_ms: Number.isFinite(Number(status.ack_p95_ms)) ? Number(status.ack_p95_ms) : null,
    throughput_last_minute: Number.isFinite(Number(status.throughput_last_minute)) ? Number(status.throughput_last_minute) : null,
    retry_rate_last_hour: Number.isFinite(Number(status.retry_rate_last_hour)) ? Number(status.retry_rate_last_hour) : null,
    dead_letter_count: Number.isFinite(Number(status.dead_letter_count)) ? Number(status.dead_letter_count) : null,
    last_error: status.last_error || null,
    current_config: status.current_config || {}
  }

  await pool.query(
    `INSERT INTO copier_runtime_status (
       status_key,
       running,
       socket_ready,
       ws_connected,
       runtime_scope,
       tenant_id,
       follower_id,
       last_heartbeat_at,
       last_db_poll_at,
       last_api_poll_at,
       last_signal_sent_at,
       queue_depth,
       mt5_host,
       mt5_port,
       bridge_heartbeat_at,
       last_snapshot_at,
       ack_p50_ms,
       ack_p95_ms,
       throughput_last_minute,
       retry_rate_last_hour,
       dead_letter_count,
       last_error,
       current_config,
       updated_at
     ) VALUES (
       $1,
       $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
       $16, $17, $18, $19, $20, $21, $22, $23, NOW()
     )
     ON CONFLICT (status_key) DO UPDATE SET
       running = EXCLUDED.running,
       socket_ready = EXCLUDED.socket_ready,
       ws_connected = EXCLUDED.ws_connected,
       runtime_scope = EXCLUDED.runtime_scope,
       tenant_id = EXCLUDED.tenant_id,
       follower_id = EXCLUDED.follower_id,
       last_heartbeat_at = EXCLUDED.last_heartbeat_at,
       last_db_poll_at = COALESCE(EXCLUDED.last_db_poll_at, copier_runtime_status.last_db_poll_at),
       last_api_poll_at = COALESCE(EXCLUDED.last_api_poll_at, copier_runtime_status.last_api_poll_at),
       last_signal_sent_at = COALESCE(EXCLUDED.last_signal_sent_at, copier_runtime_status.last_signal_sent_at),
       queue_depth = EXCLUDED.queue_depth,
       mt5_host = EXCLUDED.mt5_host,
       mt5_port = EXCLUDED.mt5_port,
       bridge_heartbeat_at = COALESCE(EXCLUDED.bridge_heartbeat_at, copier_runtime_status.bridge_heartbeat_at),
       last_snapshot_at = COALESCE(EXCLUDED.last_snapshot_at, copier_runtime_status.last_snapshot_at),
       ack_p50_ms = COALESCE(EXCLUDED.ack_p50_ms, copier_runtime_status.ack_p50_ms),
       ack_p95_ms = COALESCE(EXCLUDED.ack_p95_ms, copier_runtime_status.ack_p95_ms),
       throughput_last_minute = COALESCE(EXCLUDED.throughput_last_minute, copier_runtime_status.throughput_last_minute),
       retry_rate_last_hour = COALESCE(EXCLUDED.retry_rate_last_hour, copier_runtime_status.retry_rate_last_hour),
       dead_letter_count = COALESCE(EXCLUDED.dead_letter_count, copier_runtime_status.dead_letter_count),
       last_error = EXCLUDED.last_error,
       current_config = EXCLUDED.current_config,
       updated_at = NOW()`,
    [
      runtime.status_key,
      runtime.running,
      runtime.socket_ready,
      runtime.ws_connected,
      runtime.runtime_scope,
      runtime.tenant_id,
      runtime.follower_id,
      runtime.last_heartbeat_at,
      runtime.last_db_poll_at,
      runtime.last_api_poll_at,
      runtime.last_signal_sent_at,
      runtime.queue_depth,
      runtime.mt5_host,
      runtime.mt5_port,
      runtime.bridge_heartbeat_at,
      runtime.last_snapshot_at,
      runtime.ack_p50_ms,
      runtime.ack_p95_ms,
      runtime.throughput_last_minute,
      runtime.retry_rate_last_hour,
      runtime.dead_letter_count,
      runtime.last_error,
      JSON.stringify(runtime.current_config)
    ]
  )
}

async function insertCopierSignalLog(pool, entry = {}) {
  await pool.query(
    `INSERT INTO copier_signal_logs (
       platform_trade_id,
       instrument,
       direction,
       account_type,
       policy_applied,
       action,
       source,
       delivery_status,
       message
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      entry.platform_trade_id || null,
      entry.instrument || null,
      entry.direction || null,
      entry.account_type || null,
      entry.policy_applied || null,
      entry.action || 'OPEN',
      entry.source || null,
      entry.delivery_status || 'sent',
      entry.message || null
    ]
  )
}

module.exports = {
  ensureCopierRuntimeInfrastructure,
  insertCopierSignalLog,
  upsertCopierRuntimeStatus
}
