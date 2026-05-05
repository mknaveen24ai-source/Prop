'use strict'

require('../loadEnv')

const { Client } = require('pg')

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL })

  try {
    await client.connect()
    const result = await client.query(`
      SELECT
        running,
        last_heartbeat_at,
        EXTRACT(EPOCH FROM (NOW() - COALESCE(last_heartbeat_at, NOW() - INTERVAL '1 hour'))) AS heartbeat_age_seconds
      FROM copier_runtime_status
      WHERE status_key = 'primary'
      LIMIT 1
    `)

    const row = result.rows[0]
    if (!row) {
      process.exit(1)
      return
    }

    const heartbeatAgeSeconds = Number(row.heartbeat_age_seconds || 999999)
    const healthy = Boolean(row.running) && heartbeatAgeSeconds <= 30
    process.exit(healthy ? 0 : 1)
  } catch (_) {
    process.exit(1)
  } finally {
    await client.end().catch(() => {})
  }
}

main()
