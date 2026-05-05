const { Pool } = require('pg')
const logger = require('./utils/logger')
const { getDbContext } = require('./utils/dbContext')
require('./loadEnv')

const isNodeTest = process.env.NODE_ENV === 'test' || process.argv.includes('--test')

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  allowExitOnIdle: true
})

const wrappedClients = new WeakSet()

function buildContextSignature(context) {
  return [
    context.tenantId || '',
    context.adminRole || 'public',
    context.actorType || 'public',
    context.bypassRls ? '1' : '0'
  ].join('|')
}

async function applyContextToClient(rawQuery, client) {
  const context = getDbContext()
  const signature = buildContextSignature(context)
  if (client.__dbContextSignature === signature) {
    return
  }

  await rawQuery(
    `SELECT
       set_config('app.current_tenant_id', $1, false),
       set_config('app.current_admin_role', $2, false),
       set_config('app.actor_type', $3, false),
       set_config('app.bypass_rls', $4, false)`,
    [
      context.tenantId ? String(context.tenantId) : '',
      String(context.adminRole || 'public'),
      String(context.actorType || 'public'),
      context.bypassRls ? 'true' : 'false'
    ]
  )

  client.__dbContextSignature = signature
}

function wrapClient(client) {
  if (!client || wrappedClients.has(client)) return client

  const rawQuery = client.query.bind(client)
  client.query = async function wrappedClientQuery(...args) {
    await applyContextToClient(rawQuery, client)
    return rawQuery(...args)
  }

  wrappedClients.add(client)
  return client
}

const rawPoolConnect = pool.connect.bind(pool)
pool.connect = function wrappedPoolConnect(callback) {
  if (typeof callback === 'function') {
    return rawPoolConnect((err, client, release) => {
      if (!err && client) wrapClient(client)
      callback(err, client, release)
    })
  }
  return rawPoolConnect().then((client) => wrapClient(client))
}

const rawPoolQuery = pool.query.bind(pool)
pool.query = async function wrappedPoolQuery(...args) {
  const client = await pool.connect()
  try {
    return await client.query(...args)
  } finally {
    if (client && typeof client.release === 'function') {
      client.release()
    }
  }
}

pool.on('connect', (client) => {
  wrapClient(client)
  client.on('error', (err) => {
    logger.error('PostgreSQL client error:', { error: err.message })
  })
})

pool.on('error', (err) => {
  logger.error('PostgreSQL pool error:', { error: err.message })
})

if (!isNodeTest && process.env.DATABASE_URL) {
  rawPoolConnect((err, client, release) => {
    if (err) {
      logger.error('Database connection error:', { error: err })
    } else {
      wrapClient(client)
      logger.http('Database connection established')
      if (typeof release === 'function') release()
      else if (client && typeof client.release === 'function') client.release()
    }
  })
}

pool.__rawQuery = rawPoolQuery

module.exports = pool
