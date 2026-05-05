// NOTE: All date operations should use UTC methods (getUTC*, setUTC*)
// to ensure consistent behavior across timezones
require('./loadEnv')
const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const path = require('path')
const { createServer } = require('http')
const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const pool = require('./db')
const { Server } = require('socket.io')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const Decimal = require('decimal.js')
const { CONTRACT_SIZES } = require('./constants')
const { securityHeaders, apiLimiter, abuseDetector, requestSizeLimiter } = require('./utils/security')
const { securityMonitor } = require('./config/security-config')
const logger = require('./utils/logger')
const { withAdvisoryLock } = require('./utils/advisoryLock')
const { initializeRedis, closeRedis } = require('./utils/tokenCache')
const { initializeKafka, closeKafka } = require('./utils/kafka')
const { performanceMonitor, wrapDatabaseQuery, getMetrics, resetMetrics, getHealthStatus } = require('./utils/performance')
const { getFeedHealthForTenant, getLaunchHealthStatus } = require('./utils/launchReadiness')
const { registerIO } = require('./utils/realtime')
const {
  ensureTenantInfrastructure,
  attachTenantContext,
  isAllowedOrigin,
  resolveTenant,
  getRequestedTenantSlug,
  extractHostname
} = require('./utils/tenants')
const {
  attachDbRequestContext,
  runWithSystemDbContext
} = require('./utils/dbContext')
const {
  ensureTenantSettingsInfrastructure
} = require('./utils/tenantSettings')
const { ensureIdempotencyInfrastructure } = require('./utils/idempotency')
const { ensureTenantIsolationInfrastructure } = require('./utils/tenantIsolation')
const { sanitizeString } = require('./utils/validation')

// -- Rate limiters --
const authLimiter = rateLimit({ windowMs: 1*60*1000, max: 10, message: { error: 'Too many attempts. Wait 1 minute.' }, standardHeaders: true, legacyHeaders: false })
const supportLimiter = rateLimit({ windowMs: 60*60*1000, max: 10, message: { error: 'Too many support requests. Wait before retrying.' }, standardHeaders: true, legacyHeaders: false })
const {
  fetchAndStorePrices,
  getCurrentPrices,
  getCurrentPricesForTenant,
  syncDedicatedPriceFeedWatchers,
  subscribeSymbols,
  stopPriceFeedWatchers,
  watchPriceFeed,
  pruneOldPriceHistory,
  ensurePriceHistoryInfrastructure,
  bootstrapHistoricalPriceHistory,
  syncHourlyPriceHistory
} = require('./priceFeed')

const authRoutes    = require('./routes/auth')
const accountRoutes = require('./routes/accounts')
const {
  router: tradeRoutes,
  checkSLTP,
  checkPendingOrders,
  checkFloatingDrawdown,
  getTradingRules,
  ensureTradeExperienceInfrastructure
} = require('./routes/trades')
const adminRoutes   = require('./routes/admin')
const adminViolationRoutes = require('./routes/adminViolations')
const payoutRoutes  = require('./routes/payouts')
const kycRoutes     = require('./routes/kyc')
const chatRoutes    = require('./routes/chat')
const swaggerRoutes = require('./routes/swagger')
const tenantRoutes  = require('./routes/tenant')
const adminTenantRoutes = require('./routes/adminTenants')
const { router: billingRoutes, billingWebhookHandler, ensureBillingInfrastructure } = require('./routes/billing')
// ── TRADE COPIER ──────────────────────────────────────────────────────────────
// (copierRoutes now imported below with ensureCopierSettings)
// ─────────────────────────────────────────────────────────────────────────────
const {
  authenticateToken: authTok,
  authenticateAdmin: authAdm,
  requireSuperAdmin
} = require('./routes/middleware')
const { runChallengeEngine } = require('./challengeEngine')
const { validateEnv } = require('./env')
const newsService = require('./services/newsService')
const { ensureChatTables } = require('./routes/chat') // FIX (HIGH #6): Import for startup init
const { router: copierRoutes, ensureCopierSettings } = require('./routes/copier-routes') // FIX (HIGH #7): Import for startup init

validateEnv()

function resolveTrustProxySetting() {
  const raw = process.env.TRUST_PROXY

  if (raw == null || String(raw).trim() === '') {
    return process.env.NODE_ENV === 'production' ? 1 : false
  }

  const normalized = String(raw).trim().toLowerCase()
  if (['false', '0', 'off', 'no'].includes(normalized)) {
    return false
  }
  if (['true', '1', 'on', 'yes'].includes(normalized)) {
    return 1
  }

  if (/^\d+$/.test(normalized)) {
    return parseInt(normalized, 10)
  }

  // Allow Express trust-proxy subnet / named proxy values.
  return String(raw).trim()
}

function calculateServerPnL(direction, open_price, close_price, lots, instrument, commission = 0) {
  const contractSize = new Decimal(CONTRACT_SIZES[instrument] || 100000)
  const priceDiff = direction === 'buy'
    ? new Decimal(close_price).minus(open_price)
    : new Decimal(open_price).minus(close_price)
  return priceDiff.times(lots).times(contractSize).minus(commission).toDecimalPlaces(2).toNumber()
}

async function ensureUniqueIds() {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trader_uid TEXT`)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_trader_uid_uq ON users(trader_uid)`)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_visible BOOLEAN NOT NULL DEFAULT TRUE`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_uid TEXT`)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_uid_uq ON accounts(account_uid)`)

    await pool.query(`CREATE TABLE IF NOT EXISTS bbook_pnl (
      tenant_id         BIGINT NOT NULL DEFAULT 1,
      date              DATE NOT NULL,
      accounts_passed   INT NOT NULL DEFAULT 0,
      accounts_failed   INT NOT NULL DEFAULT 0,
      accounts_expired  INT NOT NULL DEFAULT 0,
      new_funded        INT NOT NULL DEFAULT 0,
      PRIMARY KEY (tenant_id, date)
    )`)
    await pool.query(`ALTER TABLE bbook_pnl ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1`)
    await pool.query(`CREATE INDEX IF NOT EXISTS bbook_pnl_tenant_date_idx ON bbook_pnl(tenant_id, date DESC)`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`)
    await pool.query(`UPDATE accounts SET updated_at = created_at WHERE updated_at IS NULL`)
    await pool.query(`
      CREATE OR REPLACE FUNCTION set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
      $$ LANGUAGE plpgsql
    `)
    await pool.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'accounts_upd_trigger') THEN
          CREATE TRIGGER accounts_upd_trigger
          BEFORE UPDATE ON accounts
          FOR EACH ROW EXECUTE FUNCTION set_updated_at();
        END IF;
      END $$
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trade_logs (
        id          BIGSERIAL PRIMARY KEY,
        tenant_id   BIGINT,
        trade_id    TEXT,
        user_id     TEXT,
        account_id  TEXT,
        ip_address  TEXT,
        logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`ALTER TABLE trade_logs ADD COLUMN IF NOT EXISTS tenant_id BIGINT`)
    // Backfill compatibility for older schemas that had numeric log columns.
    // Newer deployments may use UUID-like identifiers, so log columns must be TEXT.
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'trade_logs' AND column_name = 'trade_id' AND data_type <> 'text'
        ) THEN
          ALTER TABLE trade_logs ALTER COLUMN trade_id TYPE TEXT USING trade_id::text;
        END IF;
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'trade_logs' AND column_name = 'user_id' AND data_type <> 'text'
        ) THEN
          ALTER TABLE trade_logs ALTER COLUMN user_id TYPE TEXT USING user_id::text;
        END IF;
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_name = 'trade_logs' AND column_name = 'account_id' AND data_type <> 'text'
        ) THEN
          ALTER TABLE trade_logs ALTER COLUMN account_id TYPE TEXT USING account_id::text;
        END IF;
      END
      $$;
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id           BIGSERIAL PRIMARY KEY,
        tenant_id    BIGINT,
        user_id      TEXT,
        ip_address   TEXT,
        logged_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`ALTER TABLE login_logs ADD COLUMN IF NOT EXISTS tenant_id BIGINT`)

    const users = await pool.query(`SELECT id FROM users WHERE trader_uid IS NULL`)
    for (const row of users.rows) {
      await pool.query(`UPDATE users SET trader_uid = $1 WHERE id = $2`, [uuidv4(), row.id])
    }

    const accounts = await pool.query(`SELECT id FROM accounts WHERE account_uid IS NULL`)
    for (const row of accounts.rows) {
      await pool.query(`UPDATE accounts SET account_uid = $1 WHERE id = $2`, [uuidv4(), row.id])
    }

    // FIX (BUG-M5): support_tickets DDL moved from inline route handlers to startup.
    // Previously ran CREATE TABLE IF NOT EXISTS on EVERY ticket submission and every
    // admin fetch, adding a catalog scan to each request. Now runs once at boot.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id          BIGSERIAL PRIMARY KEY,
        tenant_id   BIGINT NOT NULL DEFAULT 1,
        user_id     INTEGER,
        email       TEXT,
        name        TEXT,
        category    TEXT,
        subject     TEXT NOT NULL,
        message     TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'open',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1`)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_ticket_messages (
        id          BIGSERIAL PRIMARY KEY,
        tenant_id   BIGINT NOT NULL DEFAULT 1,
        ticket_id   BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'admin')),
        sender_name TEXT,
        message     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`ALTER TABLE support_ticket_messages ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1`)
    await pool.query(`CREATE INDEX IF NOT EXISTS support_ticket_messages_ticket_idx ON support_ticket_messages(ticket_id, created_at ASC)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS support_tickets_tenant_created_idx ON support_tickets(tenant_id, created_at DESC)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS support_ticket_messages_tenant_ticket_idx ON support_ticket_messages(tenant_id, ticket_id, created_at ASC)`)
    await pool.query(`
      UPDATE support_tickets st
         SET tenant_id = COALESCE(u.tenant_id, st.tenant_id, 1)
        FROM users u
       WHERE st.user_id::text = u.id::text
         AND (st.tenant_id IS NULL OR st.tenant_id = 1)
    `)
    await pool.query(`
      UPDATE support_ticket_messages stm
         SET tenant_id = st.tenant_id
        FROM support_tickets st
       WHERE stm.ticket_id = st.id
         AND (stm.tenant_id IS NULL OR stm.tenant_id <> st.tenant_id)
    `)
  } catch (err) {
    logger.warn('[startup] Failed to backfill unique IDs:', { error: err.message })
  }
}

async function getAnnouncementState() {
  const result = await pool.query(
    `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
    [[
      'announcement_message',
      'announcement_type',
      'announcement_enabled',
      'announcement_updated_at'
    ]]
  )

  const settings = {}
  for (const row of result.rows) settings[row.key] = row.value

  const message = sanitizeString(String(settings.announcement_message || ''), 500)
  const rawType = String(settings.announcement_type || 'info').toLowerCase()
  const type = ['info', 'success', 'warning', 'error'].includes(rawType) ? rawType : 'info'
  const enabled = message.length > 0 && String(settings.announcement_enabled || 'true').toLowerCase() !== 'false'

  return {
    message,
    type,
    enabled,
    updated_at: settings.announcement_updated_at || null
  }
}

async function fetchLeaderboardRows({ tenantId = null, includeHidden = false, limit = 20 }) {
  const result = await pool.query(
    `
      WITH ranked_accounts AS (
        SELECT
          u.id AS user_id,
          u.full_name,
          u.country,
          u.trader_uid,
          COALESCE(u.leaderboard_visible, TRUE) AS visible,
          a.account_uid,
          a.account_size,
          ROUND((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0))::numeric, 2) AS profit_usd,
          ROUND(
            CASE
              WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
              ELSE ((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance) * 100
            END::numeric,
            2
          ) AS profit_pct,
          ROW_NUMBER() OVER (
            PARTITION BY u.id
            ORDER BY
              CASE
                WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
                ELSE (COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance
              END DESC,
              a.current_balance DESC,
              a.id DESC
          ) AS rn
        FROM users u
        JOIN accounts a ON a.user_id = u.id
        WHERE a.account_type = 'funded'
          AND a.status = 'active'
          AND COALESCE(u.is_banned, FALSE) = FALSE
          AND ($1::bigint IS NULL OR COALESCE(u.tenant_id, a.tenant_id, $1) = $1)
      ),
      closed_trade_stats AS (
        SELECT
          a.user_id,
          COUNT(t.id)::int AS total_trades,
          COALESCE(
            ROUND(
              CASE
                WHEN COUNT(t.id) = 0 THEN 0
                ELSE (100.0 * COUNT(t.id) FILTER (WHERE t.demo_pnl > 0) / COUNT(t.id))
              END::numeric,
              1
            ),
            0
          ) AS win_rate
        FROM accounts a
        LEFT JOIN trades t ON t.account_id = a.id AND t.status = 'closed'
        WHERE ($1::bigint IS NULL OR COALESCE(a.tenant_id, $1) = $1)
        GROUP BY a.user_id
      )
      SELECT
        r.user_id,
        r.full_name,
        r.country,
        r.trader_uid,
        r.visible,
        r.account_uid,
        r.account_size,
        r.profit_usd,
        r.profit_pct,
        COALESCE(s.total_trades, 0) AS total_trades,
        COALESCE(s.win_rate, 0) AS win_rate
      FROM ranked_accounts r
      LEFT JOIN closed_trade_stats s ON s.user_id = r.user_id
      WHERE r.rn = 1
        AND ($2::boolean = TRUE OR r.visible = TRUE)
      ORDER BY r.profit_pct DESC, r.profit_usd DESC, r.user_id ASC
      LIMIT $3
    `,
    [tenantId, includeHidden, limit]
  )

  return result.rows.map((row, index) => ({
    ...row,
    rank: index + 1,
    profit_pct: parseFloat(row.profit_pct || 0),
    profit_usd: parseFloat(row.profit_usd || 0),
    account_size: parseFloat(row.account_size || 0),
    total_trades: parseInt(row.total_trades || 0, 10),
    win_rate: parseFloat(row.win_rate || 0),
    visible: row.visible !== false
  }))
}

runWithSystemDbContext(() => ensureUniqueIds()).catch(err => {
  logger.error('[startup] Failed to ensure unique ids/infrastructure:', { error: err.message })
})
ensureTenantInfrastructure().catch(err => {
  logger.error('[startup] Failed to ensure tenant infrastructure:', { error: err.message })
})

// FIX (BUG-8): Add original_commission column to trades table.
// Stores the commission at trade-open time so partial-close math always
// computes proportional deductions from the original, not the already-reduced value.
runWithSystemDbContext(() => pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS original_commission NUMERIC(10,2)`)).catch(err => {
  logger.warn('[startup] Could not add original_commission column:', { error: err.message })
})

// FIX (HIGH #6): Run ensureChatTables once at startup instead of on every request.
// This eliminates unnecessary DDL overhead on chat route handlers.
runWithSystemDbContext(() => ensureChatTables()).catch(err => {
  logger.error('[startup] Failed to ensure chat tables:', { error: err.message })
})

// FIX (HIGH #7): Run ensureCopierSettings at startup with proper error handling.
// Previously called at module load time with silent error swallowing.
ensureCopierSettings().catch(err => {
  logger.error('[startup] Failed to ensure copier settings:', { error: err.message })
})
ensureBillingInfrastructure().catch(err => {
  logger.error('[startup] Failed to ensure billing infrastructure:', { error: err.message })
})
ensureTradeExperienceInfrastructure().catch(err => {
  logger.error('[startup] Failed to ensure trade experience infrastructure:', { error: err.message })
})
ensureTenantIsolationInfrastructure().catch(err => {
  logger.error('[startup] Failed to ensure tenant isolation infrastructure:', { error: err.message })
})
ensureIdempotencyInfrastructure().catch(err => {
  logger.error('[startup] Failed to ensure idempotency infrastructure:', { error: err.message })
})

const app = express()
const httpServer = createServer(app)
const trustProxySetting = resolveTrustProxySetting()
app.set('trust proxy', trustProxySetting)
logger.info('[startup] Express trust proxy configured', { trustProxy: trustProxySetting })

// Apply security middleware first
app.use(securityHeaders)
app.use(abuseDetector)
app.use(requestSizeLimiter)
// Add performance monitoring middleware
app.use(performanceMonitor)
app.use(apiLimiter)
// FIX: Mount attack pattern detector — checks for SQLi, path traversal, XSS
// patterns in request bodies/paths. Was defined but never mounted.
app.use(securityMonitor.checkAttackPatterns)

const io = new Server(httpServer, {
  cors: {
    origin: function(origin, callback) {
      isAllowedOrigin(origin)
        .then((allowed) => callback(null, allowed ? origin || true : false))
        .catch((error) => callback(error))
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
})

function getCookieValue(cookieHeader, key) {
  if (!cookieHeader || !key) return null
  const parts = String(cookieHeader).split(';')
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=')
    if (k === key) return decodeURIComponent(rest.join('=') || '')
  }
  return null
}

io.use(async function(socket, next) {
  try {
    await runWithSystemDbContext(async () => {
    const cookieHeader = socket.handshake?.headers?.cookie || ''
    const userToken = socket.handshake?.auth?.token || getCookieValue(cookieHeader, 'token')
    const adminToken = socket.handshake?.auth?.admin_token || getCookieValue(cookieHeader, 'admin_token')

    let userDecoded = null
    let adminDecoded = null

    if (userToken && process.env.JWT_SECRET) {
      try { userDecoded = jwt.verify(userToken, process.env.JWT_SECRET) } catch {}
    }
    if (adminToken && process.env.ADMIN_JWT_SECRET) {
      try {
        const d = jwt.verify(adminToken, process.env.ADMIN_JWT_SECRET)
        if (['admin', 'super_admin', 'tenant_admin'].includes(d?.role)) adminDecoded = d
      } catch {}
    }

    if (!userDecoded && !adminDecoded) {
      throw new Error('Unauthorized socket')
    }

    // FIX (CRITICAL #4): Validate token version against DB to support
    // instant session invalidation (password change, logout all, ban).
    // This matches the HTTP authenticateToken middleware behavior.
    if (userDecoded?.userId) {
      const socketTenant = await resolveTenant({
        slug: getRequestedTenantSlug({ headers: socket.handshake?.headers || {}, query: socket.handshake?.query || {} }),
        hostname: extractHostname(socket.handshake?.headers?.host || socket.handshake?.headers?.origin || '')
      })
      // Async token version check — non-blocking but validates session
      const result = await pool.query(
        'SELECT token_version, is_banned, tenant_id FROM users WHERE id = $1',
        [userDecoded.userId]
      )
      if (result.rows.length === 0) {
        throw new Error('User not found')
      }
      const { token_version, is_banned, tenant_id } = result.rows[0]
      if (is_banned) {
        throw new Error('Account suspended')
      }
      if (socketTenant?.id && tenant_id && String(socketTenant.id) !== String(tenant_id)) {
        throw new Error('Wrong tenant portal')
      }
      if (userDecoded.tv !== undefined && userDecoded.tv < token_version) {
        throw new Error('Session expired')
      }
      socket.data.userId = String(userDecoded.userId)
      socket.data.tenantId = tenant_id || socketTenant?.id || null
      socket.join(socket.data.userId)
      if (socket.data.tenantId) {
        socket.join(`prices:tenant:${socket.data.tenantId}`)
      }
    }
    if (adminDecoded) {
      if (adminDecoded.role === 'tenant_admin') {
        await ensureTenantSettingsInfrastructure()
        const tenantAdminResult = await pool.query(
          `SELECT id, tenant_id, status, token_version
             FROM tenant_admins
            WHERE id = $1`,
          [adminDecoded.adminId]
        )
        if (tenantAdminResult.rows.length === 0) {
          throw new Error('Tenant admin not found')
        }
        const tenantAdmin = tenantAdminResult.rows[0]
        if (tenantAdmin.status !== 'active') {
          throw new Error('Tenant admin inactive')
        }
        if (adminDecoded.tid && String(adminDecoded.tid) !== String(tenantAdmin.tenant_id)) {
          throw new Error('Tenant admin token invalid')
        }
        if ((adminDecoded.atv || 0) < parseInt(tenantAdmin.token_version || 1, 10)) {
          throw new Error('Admin session expired')
        }
        socket.data.isAdmin = true
        socket.data.adminRole = 'tenant_admin'
        socket.data.tenantId = tenantAdmin.tenant_id
        socket.join(`admin:tenant:${tenantAdmin.tenant_id}`)
        socket.join(`prices:tenant:${tenantAdmin.tenant_id}`)
      } else {
        const result = await pool.query(
          `SELECT value FROM platform_settings WHERE key = 'admin_token_version'`
        )
        if (result.rows.length > 0) {
          const serverVersion = parseInt(result.rows[0].value, 10)
          const tokenVersion = adminDecoded.atv || 0
          if (!Number.isNaN(serverVersion) && tokenVersion < serverVersion) {
            throw new Error('Admin session expired')
          }
        }
        socket.data.isAdmin = true
        socket.data.adminRole = 'super_admin'
        socket.join('admin')
        socket.join('admin:super')
      }
    }

    })
    next()
  } catch (err) {
    next(err)
  }
})

const trackedIntervals = new Set()
const trackedTimeouts = new Set()
const activeHttpSockets = new Set()
let shutdownInProgress = false

function registerTrackedInterval(fn, intervalMs) {
  const handle = setInterval(fn, intervalMs)
  trackedIntervals.add(handle)
  return handle
}

function registerTrackedTimeout(fn, delayMs) {
  const handle = setTimeout(() => {
    trackedTimeouts.delete(handle)
    fn()
  }, delayMs)
  trackedTimeouts.add(handle)
  return handle
}

function clearTrackedTimers() {
  for (const handle of trackedIntervals) {
    clearInterval(handle)
  }
  trackedIntervals.clear()

  for (const handle of trackedTimeouts) {
    clearTimeout(handle)
  }
  trackedTimeouts.clear()
}

httpServer.on('connection', (socket) => {
  activeHttpSockets.add(socket)
  socket.on('close', () => {
    activeHttpSockets.delete(socket)
  })
})

app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? { directives: { defaultSrc:["'self'"], styleSrc:["'self'","'unsafe-inline'"], imgSrc:["'self'","data:","https:"], connectSrc:["'self'","wss:"], fontSrc:["'self'"], frameSrc:["'none'"], objectSrc:["'none'"], upgradeInsecureRequests:[] } } : false,
  crossOriginEmbedderPolicy: false,
  // FIX (LOW #28): Configure helmet to set all security headers instead of
  // duplicating them manually below. Eliminates redundancy.
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  permissionsPolicy: {
    geolocation: [],
    microphone: [],
    camera: []
  }
}))
app.use(cors({
  origin: function(origin, callback) {
    isAllowedOrigin(origin)
      .then((allowed) => callback(null, allowed ? origin || true : false))
      .catch((error) => callback(error))
  },
  credentials: true
}))
app.post('/api/billing/stripe/webhook', express.raw({ type: 'application/json' }), billingWebhookHandler)
app.use(express.json())
app.use(cookieParser())
app.disable('x-powered-by')
app.use(logger.httpMiddleware)
app.use(attachTenantContext)
app.use(attachDbRequestContext)
// FIX (LOW #28): Removed duplicate manual header setting — helmet now handles it.
// Only keep x-powered-by disable (already done above) and any custom headers
// that helmet doesn't cover.

// ── Secure uploads: require admin JWT ─────────────────────────────────────────
const uploadsRoot = path.resolve(__dirname, 'uploads')

app.use('/uploads', authAdm, function(req, res) {
  const relPath = req.path.replace(/^\/+/, '')
  const absPath = path.resolve(uploadsRoot, relPath)
  if (!absPath.startsWith(uploadsRoot + path.sep) && absPath !== uploadsRoot) {
    return res.status(400).json({ error: 'Invalid path' })
  }
  res.sendFile(absPath, function(err) {
    if (err) {
      const status = err.statusCode || 404
      res.status(status).json({ error: 'File not found' })
    }
  })
})

// Wrap database queries for performance tracking
wrapDatabaseQuery(pool)

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/setup',    require('./routes/setup'))     // First-run setup & checklist (no auth)
app.use('/api/auth',     authLimiter,          authRoutes)
app.use('/api/docs',     swaggerRoutes)
app.use('/api/tenant',   tenantRoutes)
app.use('/api/accounts', accountRoutes)
app.use('/api/trades',   tradeRoutes)
app.use('/api/admin',    adminRoutes)
app.use('/api/admin',    adminViolationRoutes)
app.use('/api/admin',    adminTenantRoutes)
app.use('/api/admin',    copierRoutes)   // ← TRADE COPIER ROUTES (admin-protected)
app.use('/api/payouts',  payoutRoutes)
app.use('/api/kyc',      kycRoutes)
app.use('/api/chat',     chatRoutes)
app.use('/api/disputes', require('./routes/disputes'))
app.use('/api/billing',  billingRoutes)

// ── Performance & Health Endpoints ────────────────────────────────────────────
app.get('/api/health', async function(req, res) {
  try {
    const tenantId = req.tenant?.id || null
    res.json(await getLaunchHealthStatus(tenantId))
  } catch (error) {
    logger.error('Health endpoint error:', { error: error.message })
    const fallback = getHealthStatus()
    res.status(503).json({
      ...fallback,
      status: 'unhealthy',
      launch_ready: false,
      error: 'Could not build launch health summary'
    })
  }
})

app.get('/api/metrics', authAdm, requireSuperAdmin, function(req, res) {
  res.json(getMetrics())
})

app.post('/api/metrics/reset', authAdm, requireSuperAdmin, function(req, res) {
  resetMetrics()
  res.json({ message: 'Metrics reset successfully' })
})

app.get('/api/announcement', async function(req, res) {
  try {
    const announcement = await getAnnouncementState()
    if (!announcement.enabled) {
      return res.json(null)
    }
    res.json({
      message: announcement.message,
      type: announcement.type,
      updated_at: announcement.updated_at
    })
  } catch (error) {
    logger.error('Public announcement error:', { error: error.message })
    res.status(500).json({ error: 'Could not load announcement' })
  }
})

app.get('/api/leaderboard', async function(req, res) {
  try {
    const tenantId = req.tenant?.id || 1
    const rows = await fetchLeaderboardRows({ tenantId, includeHidden: false, limit: 20 })
    res.json(rows)
  } catch (error) {
    logger.error('Leaderboard error:', { error: error.message })
    res.status(500).json({ error: 'Could not load leaderboard' })
  }
})

// ── Support tickets ───────────────────────────────────────────────────────────
app.post('/api/support/ticket', supportLimiter, function optionalAuth(req, res, next) {
  const jwtLib = require('jsonwebtoken')
  const token = req.cookies?.token || (req.headers.authorization || '').split(' ')[1]
  if (token) {
    try { req.user = jwtLib.verify(token, process.env.JWT_SECRET) } catch {}
  }
  next()
}, async function(req, res) {
  try {
    const { category, subject, message, email, name } = req.body
    const user_id = req.user?.userId
    const tenantId = req.user?.tenantId || req.tenant?.id || 1
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required' })
    }
    // FIX (BUG-M5): DDL removed from here — table is created at startup in ensureUniqueIds()
    await pool.query(
      `INSERT INTO support_tickets (tenant_id, user_id, email, name, category, subject, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, user_id || null, email || null, name || null, category || 'other', subject, message]
    )
    res.status(201).json({ message: 'Support ticket submitted successfully' })
  } catch (error) {
    logger.error('Support ticket error:', { error: error.message })
    res.status(500).json({ error: 'Could not submit support ticket' })
  }
})

async function loadUserSupportTickets(req, res) {
  try {
    const tenantId = req.user?.tenantId || req.tenant?.id || 1
    const result = await pool.query(
      `SELECT id, category, subject, message, status, created_at
       FROM support_tickets
       WHERE user_id = $1
         AND tenant_id = $2
       ORDER BY created_at DESC`,
      [req.user.userId, tenantId]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Load support tickets error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch tickets' })
  }
}

app.get('/api/support/tickets', authTok, loadUserSupportTickets)
app.get('/api/support/my-tickets', authTok, loadUserSupportTickets)

app.get('/api/support/ticket/:id', authTok, async function(req, res) {
  try {
    const tenantId = req.user?.tenantId || req.tenant?.id || 1
    const ticketId = parseInt(req.params.id, 10)
    if (!Number.isFinite(ticketId)) {
      return res.status(400).json({ error: 'Invalid ticket id' })
    }

    const ticketResult = await pool.query(
      `SELECT id, user_id, category, subject, message, status, created_at
       FROM support_tickets
       WHERE id = $1 AND user_id = $2 AND tenant_id = $3`,
      [ticketId, req.user.userId, tenantId]
    )
    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' })
    }

    const messagesResult = await pool.query(
      `SELECT id, sender_type, sender_name, message, created_at
       FROM support_ticket_messages
       WHERE ticket_id = $1 AND tenant_id = $2
       ORDER BY created_at ASC, id ASC`,
      [ticketId, tenantId]
    )

    res.json({
      ticket: ticketResult.rows[0],
      messages: messagesResult.rows
    })
  } catch (error) {
    logger.error('Load support ticket detail error:', { error: error.message })
    res.status(500).json({ error: 'Could not load ticket thread' })
  }
})

app.post('/api/support/ticket/:id/reply', authTok, async function(req, res) {
  try {
    const tenantId = req.user?.tenantId || req.tenant?.id || 1
    const ticketId = parseInt(req.params.id, 10)
    if (!Number.isFinite(ticketId)) {
      return res.status(400).json({ error: 'Invalid ticket id' })
    }

    const message = sanitizeString(String(req.body?.message || ''), 2000)
    if (!message) {
      return res.status(400).json({ error: 'Reply message is required' })
    }

    const ticketResult = await pool.query(
      `SELECT id, status
       FROM support_tickets
       WHERE id = $1 AND user_id = $2 AND tenant_id = $3`,
      [ticketId, req.user.userId, tenantId]
    )
    if (ticketResult.rows.length === 0) {
      return res.status(404).json({ error: 'Ticket not found' })
    }
    if (ticketResult.rows[0].status === 'closed') {
      return res.status(400).json({ error: 'Closed tickets cannot receive new replies' })
    }

    const replyResult = await pool.query(
      `INSERT INTO support_ticket_messages (tenant_id, ticket_id, sender_type, sender_name, message)
       VALUES ($1, $2, 'user', $3, $4)
       RETURNING id, sender_type, sender_name, message, created_at`,
      [tenantId, ticketId, 'You', message]
    )

    res.status(201).json({
      message: 'Reply sent successfully',
      reply: replyResult.rows[0]
    })
  } catch (error) {
    logger.error('Support ticket reply error:', { error: error.message })
    res.status(500).json({ error: 'Could not send reply' })
  }
})

app.get('/api/admin/support-tickets', authAdm, async function(req, res) {
  try {
    const tenantId = req.admin?.tenantId || null
    const result = await pool.query(
      `SELECT * FROM support_tickets
       WHERE ($1::bigint IS NULL OR tenant_id = $1)
       ORDER BY created_at DESC`,
      [tenantId]
    )
    res.json(result.rows)
  } catch (error) { res.status(500).json({ error: 'Could not fetch tickets' }) }
})

app.patch('/api/admin/support-tickets/:id', authAdm, async function(req, res) {
  try {
    const tenantId = req.admin?.tenantId || null
    const { status } = req.body
    if (!['open', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }
    const result = await pool.query(
      `UPDATE support_tickets
          SET status = $1
        WHERE id = $2
          AND ($3::bigint IS NULL OR tenant_id = $3)
        RETURNING *`,
      [status, req.params.id, tenantId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' })
    res.json({ message: 'Ticket updated', ticket: result.rows[0] })
  } catch (error) { res.status(500).json({ error: 'Could not update ticket' }) }
})

// ── Disputes ──────────────────────────────────────────────────────────────────
async function ensureDisputesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS disputes (
      id             BIGSERIAL PRIMARY KEY,
      tenant_id      BIGINT NOT NULL DEFAULT 1,
      user_id        INTEGER   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id     INTEGER,
      reason         TEXT      NOT NULL,
      description    TEXT      NOT NULL,
      status         TEXT      NOT NULL DEFAULT 'open',
      admin_response TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`ALTER TABLE disputes ADD COLUMN IF NOT EXISTS tenant_id BIGINT NOT NULL DEFAULT 1`)
  await pool.query(`CREATE INDEX IF NOT EXISTS disputes_tenant_created_idx ON disputes(tenant_id, created_at DESC)`)
  await pool.query(`
    UPDATE disputes d
       SET tenant_id = COALESCE(u.tenant_id, d.tenant_id, 1)
      FROM users u
     WHERE d.user_id = u.id
       AND (d.tenant_id IS NULL OR d.tenant_id = 1)
  `)
}

app.post('/api/disputes/submit', authTok, async function(req, res) {
  try {
    await ensureDisputesTable()
    const tenantId = req.user?.tenantId || req.tenant?.id || 1
    const { account_id, reason, description } = req.body
    const accountId = account_id === undefined || account_id === null || account_id === ''
      ? null
      : String(account_id).trim()
    if (!reason || !description?.trim()) {
      return res.status(400).json({ error: 'reason and description are required' })
    }
    if (description.trim().length < 30) {
      return res.status(400).json({ error: 'Description must be at least 30 characters' })
    }
    if (accountId !== null && (!String(accountId).trim())) {
      return res.status(400).json({ error: 'Invalid account ID' })
    }
    if (accountId !== null) {
      const owned = await pool.query(
        `SELECT id FROM accounts WHERE id = $1 AND user_id = $2 AND COALESCE(tenant_id, $3) = $3`,
        [accountId, req.user.userId, tenantId]
      )
      if (owned.rows.length === 0) {
        return res.status(404).json({ error: 'Account not found' })
      }
      const existing = await pool.query(
        `SELECT id FROM disputes WHERE user_id = $1 AND account_id = $2 AND status IN ('open','under_review')`,
        [req.user.userId, accountId]
      )
      if (existing.rows.length > 0) {
        return res.status(400).json({ error: 'You already have an open dispute for this account' })
      }
    }
    // Require at least 1 closed trade before filing a dispute
    const tradeCheck = await pool.query(
      `SELECT COUNT(*)
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE a.user_id = $1
          AND COALESCE(a.tenant_id, $2) = $2
          AND t.status = 'closed'`,
      [req.user.userId, tenantId]
    )
    if (parseInt(tradeCheck.rows[0].count) < 1) {
      return res.status(400).json({ error: 'You must have at least one completed trade before filing a dispute.' })
    }
    const result = await pool.query(
      `INSERT INTO disputes (tenant_id, user_id, account_id, reason, description)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [tenantId, req.user.userId, accountId, reason, description.trim()]
    )
    res.status(201).json({ message: 'Dispute submitted', dispute: result.rows[0] })
  } catch (error) {
    logger.error('Submit dispute error:', { error: error.message })
    res.status(500).json({ error: 'Could not submit your dispute. Please try again.' })
  }
})

app.get('/api/disputes/my-disputes', authTok, async function(req, res) {
  try {
    await ensureDisputesTable()
    const tenantId = req.user?.tenantId || req.tenant?.id || 1
    const result = await pool.query(
      `SELECT d.*, a.account_uid, a.account_type, a.account_size
       FROM disputes d
       LEFT JOIN accounts a ON d.account_id = a.id
       WHERE d.user_id = $1
         AND d.tenant_id = $2
       ORDER BY d.created_at DESC`,
      [req.user.userId, tenantId]
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not load disputes.' })
  }
})

app.get('/api/disputes/all', authAdm, async function(req, res) {
  try {
    await ensureDisputesTable()
    const tenantId = req.admin?.tenantId || null
    const result = await pool.query(
      `SELECT d.*, u.email, u.full_name, u.trader_uid,
              a.account_uid, a.account_type, a.account_size, a.status as account_status
       FROM disputes d
       JOIN users u ON d.user_id = u.id
       LEFT JOIN accounts a ON d.account_id = a.id
       WHERE ($1::bigint IS NULL OR d.tenant_id = $1)
       ORDER BY d.created_at DESC`,
      [tenantId]
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not load disputes.' })
  }
})

app.patch('/api/disputes/:id', authAdm, async function(req, res) {
  try {
    await ensureDisputesTable()
    const tenantId = req.admin?.tenantId || null
    const { id } = req.params
    const { status, admin_response } = req.body
    const valid = ['open', 'under_review', 'resolved', 'rejected']
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` })
    }
    const result = await pool.query(
      `UPDATE disputes SET status = $1, admin_response = $2, updated_at = NOW()
       WHERE id = $3
         AND ($4::bigint IS NULL OR tenant_id = $4)
       RETURNING *`,
      [status, admin_response || null, id, tenantId]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dispute not found' })
    res.json({ message: 'Dispute updated', dispute: result.rows[0] })
  } catch (error) {
    logger.error('Update dispute error:', { error: error.message })
    res.status(500).json({ error: 'Could not update dispute' })
  }
})

// ── Health / prices ───────────────────────────────────────────────────────────
app.get('/', function(req, res) {
  res.json({ message: 'Prop Firm API running', status: 'OK', timestamp: new Date() })
})

app.get('/api/prices', async function(req, res) {
  try {
    const tenantId = req.tenant?.id || null
    const prices = tenantId
      ? await getCurrentPricesForTenant(tenantId)
      : await getCurrentPrices()
    res.json(prices)
  } catch (error) {
    logger.error('Prices error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch prices' })
  }
})

// HTF Chart Aggregation from raw ticks
app.get('/api/prices/chart/:instrument', async function(req, res) {
  try {
    const { instrument } = req.params
    const timeframeMins = parseInt(req.query.tf) || 1
    
    // Group ticks into OHLC candles. 
    // Uses 1-minute buckets by default, filtering the last 2000 records.
    const query = `
      SELECT 
        date_trunc('minute', recorded_at) - ((EXTRACT(MINUTE FROM recorded_at)::integer % $1) || ' minutes')::interval AS bucket,
        (array_agg(bid ORDER BY recorded_at ASC))[1] as open,
        MAX(bid) as high,
        MIN(bid) as low,
        (array_agg(bid ORDER BY recorded_at DESC))[1] as close
      FROM price_feed_history
      WHERE instrument = $2
      GROUP BY bucket
      ORDER BY bucket DESC
      LIMIT 1000
    `
    const result = await pool.query(query, [timeframeMins, instrument])
    
    // Format for Lightweight Charts: { time, open, high, low, close }
    const formatted = result.rows.reverse().map(row => ({
      time: Math.floor(new Date(row.bucket).getTime() / 1000),
      open: parseFloat(row.open),
      high: parseFloat(row.high),
      low: parseFloat(row.low),
      close: parseFloat(row.close)
    }))
    
    res.json(formatted)
  } catch (error) {
    logger.error('Chart aggregate error:', { error: error.message })
    res.status(500).json({ error: 'Could not group chart data' })
  }
})

// Price feed status endpoint (public - for users to check feed health)
app.get('/api/price-status', async function(req, res) {
  try {
    const tenantId = req.tenant?.id || null
    res.json(await getFeedHealthForTenant(tenantId))
  } catch (error) {
    logger.error('Price status error:', { error: error.message })
    res.status(500).json({ error: 'Could not check price status', healthy: false })
  }
})

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', function(socket) {
  logger.http('Socket connected:', { socketId: socket.id, isAdmin: socket.data?.isAdmin ? '[admin]' : `[user:${socket.data?.userId}]` })
  
  socket.on('join_account', async function(userId) {
    const requested = String(userId || '').trim()
    if (!requested) return

    if (socket.data?.isAdmin) {
      if (requested === 'admin:super' && socket.data?.adminRole === 'super_admin') {
        socket.join(requested)
        return
      }
      if (requested === 'admin' && socket.data?.adminRole === 'super_admin') {
        socket.join(requested)
        return
      }
      if (requested === `admin:tenant:${socket.data?.tenantId}`) {
        socket.join(requested)
        return
      }

      if (/^\d+$/.test(requested)) {
        try {
          const result = await pool.query(
            `SELECT id, tenant_id
               FROM users
              WHERE id = $1
              LIMIT 1`,
            [requested]
          )
          if (result.rows.length === 0) {
            socket.emit('auth_error', { error: 'User room not found' })
            return
          }

          const target = result.rows[0]
          if (
            socket.data?.adminRole === 'super_admin' ||
            String(target.tenant_id || '') === String(socket.data?.tenantId || '')
          ) {
            socket.join(requested)
            return
          }
        } catch (error) {
          logger.warn('Socket join_account authorization failed:', { error: error.message })
        }
      }

      socket.emit('auth_error', { error: 'Unauthorized room join' })
      return
    }

    if (socket.data?.userId && requested === socket.data.userId) {
      socket.join(requested)
      return
    }

    socket.emit('auth_error', { error: 'Unauthorized room join' })
  })

  // Chat-specific socket events
  socket.on('join_chat', async function(conversationId) {
    const parsedConversationId = parseInt(conversationId, 10)
    if (!Number.isFinite(parsedConversationId) || parsedConversationId <= 0) {
      socket.emit('auth_error', { error: 'Invalid conversation id' })
      return
    }

    if (socket.data?.isAdmin) {
      try {
        const adminTenantId = socket.data?.adminRole === 'tenant_admin'
          ? (socket.data?.tenantId || null)
          : null
        const result = await pool.query(
          `SELECT id, tenant_id
             FROM chat_conversations
            WHERE id = $1
              AND ($2::bigint IS NULL OR tenant_id = $2)
            LIMIT 1`,
          [parsedConversationId, adminTenantId]
        )
        if (result.rows.length === 0) {
          socket.emit('auth_error', { error: 'Unauthorized chat access' })
          return
        }
        socket.join(`chat:${parsedConversationId}`)
        return
      } catch (error) {
        logger.warn('Socket admin join_chat authorization failed:', { error: error.message })
        socket.emit('auth_error', { error: 'Could not join chat room' })
        return
      }
    }

    if (!socket.data?.userId) {
      socket.emit('auth_error', { error: 'Unauthorized chat access' })
      return
    }

    try {
      const tenantId = socket.data?.tenantId || null
      const result = await pool.query(
        `SELECT 1
           FROM chat_conversations
          WHERE id = $1 AND user_id = $2
            AND ($3::bigint IS NULL OR tenant_id = $3)`,
        [parsedConversationId, socket.data.userId, tenantId]
      )
      if (result.rows.length === 0) {
        socket.emit('auth_error', { error: 'Unauthorized chat access' })
        return
      }

      socket.join(`chat:${parsedConversationId}`)
    } catch (error) {
      logger.warn('Socket join_chat authorization failed:', { error: error.message })
      socket.emit('auth_error', { error: 'Could not join chat room' })
    }
  })

  socket.on('leave_chat', function(conversationId) {
    const parsedConversationId = parseInt(conversationId, 10)
    if (!Number.isFinite(parsedConversationId) || parsedConversationId <= 0) return
    socket.leave(`chat:${parsedConversationId}`)
  })

  socket.on('typing_start', function({ conversationId, isTyping }) {
    const parsedConversationId = parseInt(conversationId, 10)
    if (!Number.isFinite(parsedConversationId) || parsedConversationId <= 0) return
    const room = `chat:${parsedConversationId}`
    if (!socket.rooms.has(room)) return
    if (socket.data?.isAdmin) {
      socket.to(room).emit('user_typing', {
        conversationId: parsedConversationId,
        isTyping,
        isAdmin: true
      })
    } else {
      socket.to(room).emit('user_typing', {
        conversationId: parsedConversationId,
        isTyping,
        userId: socket.data?.userId
      })
    }
  })

  socket.on('disconnect', function() {
    logger.http('Socket disconnected:', { socketId: socket.id })
  })
})

app.set('io', io)
registerIO(io)

// ── Price feed ────────────────────────────────────────────────────────────────
let lastEmittedPricesHash = ''
let lastWatcherEmitAt = 0
let tenantPriceBroadcastCache = new Map()
let cachedPriceBroadcastTenantIds = []
let cachedPriceBroadcastTenantIdsAt = 0

async function getPriceBroadcastTenantIds() {
  if ((Date.now() - cachedPriceBroadcastTenantIdsAt) < 30 * 1000 && cachedPriceBroadcastTenantIds.length > 0) {
    return cachedPriceBroadcastTenantIds
  }

  const result = await pool.query(
    `SELECT id
       FROM tenants
      WHERE status IN ('active', 'default', 'trial', 'pending', 'paused')`
  )
  cachedPriceBroadcastTenantIds = result.rows
    .map((row) => parseInt(row.id, 10))
    .filter((id) => Number.isFinite(id) && id > 0)
  cachedPriceBroadcastTenantIdsAt = Date.now()
  return cachedPriceBroadcastTenantIds
}

async function emitTenantPriceUpdates(rawPrices) {
  return runWithSystemDbContext(async () => {
    const tenantIds = await getPriceBroadcastTenantIds()
    const nextCache = new Map()

    await Promise.all(
      tenantIds.map(async (tenantId) => {
        const tenantPrices = await getCurrentPricesForTenant(tenantId, rawPrices)
        const tenantHash = JSON.stringify(tenantPrices)
        nextCache.set(String(tenantId), tenantHash)
        if (tenantHash !== tenantPriceBroadcastCache.get(String(tenantId))) {
          io.to(`prices:tenant:${tenantId}`).emit('price_update', tenantPrices)
          io.to(`admin:tenant:${tenantId}`).emit('price_update', tenantPrices)
        }
      })
    )

    tenantPriceBroadcastCache = nextCache
  })
}

function runLockedSchedulerJob(lockName, label, fn) {
  return withAdvisoryLock(lockName, () => runWithSystemDbContext(fn)).catch((error) => {
    logger.error(`[scheduler:${label}] execution error:`, { error: error.message })
  })
}

async function runInitialPriceFeedMaintenance() {
  try {
    await runWithSystemDbContext(async () => {
      await bootstrapHistoricalPriceHistory()
      await pruneOldPriceHistory()
    })
  } catch (error) {
    logger.error('Price history init error:', { error: error.message })
  }
}

async function startPriceFeedPipeline() {
  await runWithSystemDbContext(async () => {
    try {
      await ensurePriceHistoryInfrastructure()
      await ensureTenantSettingsInfrastructure()
      subscribeSymbols()
      await fetchAndStorePrices()
      await syncDedicatedPriceFeedWatchers(() => {
        emitTenantPriceUpdates().catch((error) => {
          logger.error('Tenant price broadcast error:', { error: error.message })
        })
      })
    } catch (error) {
      logger.error('Failed to start price feed pipeline:', { error: error.message })
    }
  })

  registerTrackedTimeout(() => {
    runInitialPriceFeedMaintenance().catch((error) => {
      logger.error('Deferred price history init error:', { error: error.message })
    })
  }, 0)

  registerTrackedInterval(pruneOldPriceHistory, 24 * 60 * 60 * 1000)
  registerTrackedInterval(syncHourlyPriceHistory, 30 * 60 * 1000)
  registerTrackedInterval(() => {
    syncDedicatedPriceFeedWatchers(() => {
      emitTenantPriceUpdates().catch((error) => {
        logger.error('Tenant price broadcast error:', { error: error.message })
      })
    }).catch((error) => {
      logger.error('Dedicated price feed sync error:', { error: error.message })
    })
  }, 30 * 1000)

  // FIX (BUG-M6): Track last emitted prices to avoid broadcasting identical data
  // every second. Only emit when at least one price has actually changed.
  watchPriceFeed(function(prices) {
    lastWatcherEmitAt = Date.now()
    const hash = JSON.stringify(prices)
    if (hash !== lastEmittedPricesHash) {
      lastEmittedPricesHash = hash
      io.emit('price_update', prices)
      io.to('admin:super').emit('price_update', prices)
      emitTenantPriceUpdates(prices).catch((error) => {
        logger.error('Tenant price broadcast error:', { error: error.message })
      })
    }
  })

  // Fallback polling - runs every 1 second to ensure prices stay fresh if watcher fails
  registerTrackedInterval(async function() {
    try {
      if ((Date.now() - lastWatcherEmitAt) < 1500) {
        return
      }
      const fetchResult = await fetchAndStorePrices()
      if (fetchResult?.liveFeedAvailable === false || fetchResult?.updated !== true) {
        return
      }

      const prices = fetchResult.prices || await getCurrentPrices()
      if (Object.keys(prices).length > 0) {
        const hash = JSON.stringify(prices)
        if (hash !== lastEmittedPricesHash) {
          lastEmittedPricesHash = hash
          io.emit('price_update', prices)
          io.to('admin:super').emit('price_update', prices)
          emitTenantPriceUpdates(prices).catch((error) => {
            logger.error('Tenant price broadcast error:', { error: error.message })
          })
        }
      }
    } catch (error) {
      logger.error('Price fallback interval error:', { error: error.message })
    }
  }, 1000)
}

startPriceFeedPipeline().catch((error) => {
  logger.error('Failed to start price feed pipeline:', { error: error.message })
})

// ── Trading engine intervals ──────────────────────────────────────────────────
registerTrackedInterval(function() {
  runLockedSchedulerJob('jobs:check_sltp', 'check_sltp', () => checkSLTP(io))
}, 500)
registerTrackedInterval(function() {
  runLockedSchedulerJob('jobs:check_pending_orders', 'check_pending_orders', () => checkPendingOrders(io))
}, 500)
// FIX (HIGH #12): Reduced from 500ms to 1000ms to lower database query volume
// under heavy load with many active accounts.
registerTrackedInterval(function() {
  runLockedSchedulerJob('jobs:check_floating_drawdown', 'check_floating_drawdown', () => checkFloatingDrawdown(io))
}, 1000)

// ── Challenge engine ──────────────────────────────────────────────────────────
runLockedSchedulerJob('jobs:challenge_engine', 'challenge_engine', () => runChallengeEngine(io))
registerTrackedInterval(() => {
  runLockedSchedulerJob('jobs:challenge_engine', 'challenge_engine', () => runChallengeEngine(io))
}, 30000)

// ── News Protection ───────────────────────────────────────────────────────────
newsService.start()
let lastClosedNewsId = ''

async function checkNewsForceClose() {
  // FIX (BUG-1 + BUG-7): client declared outside try so finally always releases it.
  let client
  try {
    // 3 minute window as per strict rules
    const activeNews = newsService.getActiveNewsEvent(3)
    if (!activeNews) {
      lastClosedNewsId = ''
      return
    }

    // Only close trades once per news event window
    const newsId = `${activeNews.title}_${activeNews.timestamp}`
    if (lastClosedNewsId === newsId) return

    const openTrades = await pool.query(
      `SELECT t.*, a.user_id, a.tenant_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'`
    )
    if (openTrades.rows.length === 0) return

    logger.info(`[news_close] Active USD High Impact: ${activeNews.title} — force-closing ${openTrades.rows.length} trades`)

    client = await pool.connect()
    let closeErrors = 0
    const tenantPriceCache = new Map()

    for (const trade of openTrades.rows) {
      try {
        const tenantKey = String(trade.tenant_id || 1)
        if (!tenantPriceCache.has(tenantKey)) {
          tenantPriceCache.set(tenantKey, await getCurrentPricesForTenant(trade.tenant_id || 1))
        }
        const priceData = tenantPriceCache.get(tenantKey)?.[trade.instrument]
        if (!priceData) {
          closeErrors += 1
          logger.warn(`[weekend_close] Missing live price for ${trade.instrument}; trade ${trade.id} left open for retry`)
          continue
        }

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const demo_pnl = calculateServerPnL(
          trade.direction,
          parseFloat(trade.open_price),
          close_price,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        await client.query('BEGIN')
        const locked = await client.query(
          `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
          [trade.id]
        )
        if (locked.rows.length === 0) { await client.query('ROLLBACK'); continue }

        await client.query(
          `UPDATE trades SET status='closed', close_price=$1, close_time=NOW(), demo_pnl=$2, close_reason='News Force Close' WHERE id=$3`,
          [close_price, demo_pnl, trade.id]
        )

        // FIX (BUG-1): Balance was NEVER updated after news force-close.
        // Without this the account balance stays stale and drawdown checks
        // operate on wrong equity, potentially missing real limit breaches.
        await client.query(
          `UPDATE accounts SET
             current_balance = current_balance + $1,
             peak_balance    = GREATEST(peak_balance, current_balance + $1),
             updated_at      = NOW()
           WHERE id = $2`,
          [demo_pnl, trade.account_id]
        )

        await client.query('COMMIT')

        io.to(String(trade.user_id)).emit('trade_closed', { trade_id: trade.id, reason: 'News Force Close', pnl: demo_pnl })
      } catch (err) {
        closeErrors += 1
        await client.query('ROLLBACK').catch(() => {})
        logger.error(`[news_close] Error closing trade ${trade.id}:`, { error: err.message })
      }
    }

    if (closeErrors === 0) lastClosedNewsId = newsId
    else lastClosedNewsId = ''

  } catch (error) {
    logger.error('[news_close] Force-close check error:', { error: error.message })
    lastClosedNewsId = '' // Reset to allow retry on next interval
  } finally {
    // FIX (BUG-7): Guaranteed release — prevents pool exhaustion under any code path.
    if (client) client.release()
  }
}
registerTrackedInterval(() => {
  runLockedSchedulerJob('jobs:news_force_close', 'news_force_close', checkNewsForceClose)
}, 10000)

// FIX (BUG-M2): Added deduplication flag to prevent the force-close from
// firing multiple times in the same 2-minute Friday window. The interval runs
// every 60s; without this flag it could fire twice (at 21:58 and 21:59).
let weekendCloseExecutedDate = ''

async function weekendForceClose() {
  try {
    const now       = new Date()
    const dayUTC    = now.getUTCDay()
    const hourUTC   = now.getUTCHours()
    const minuteUTC = now.getUTCMinutes()

    // Weekend holding disabled: flatten open exposure shortly after Friday 21:00 UTC.
    if (dayUTC !== 5) return
    const inWindow = hourUTC === 21 && minuteUTC < 10
    if (!inWindow) return

    // FIX (BUG-M2): Dedup — only run once per Friday using date string key
    const todayKey = now.toISOString().slice(0, 10) // e.g. '2026-03-27'
    if (weekendCloseExecutedDate === todayKey) return

    const openTrades = await pool.query(
      `SELECT t.*, a.user_id, a.tenant_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'`
    )
    const pendingOrders = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.order_type, a.user_id, a.tenant_id
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'pending'`
    )
    if (openTrades.rows.length === 0 && pendingOrders.rows.length === 0) return

    logger.info(`[weekend_close] Friday 21:00–21:09 UTC — flattening ${openTrades.rows.length} open trade(s) and cancelling ${pendingOrders.rows.length} pending order(s)`)

    const prices = await getCurrentPrices()
    let closeErrors = 0

    for (const trade of openTrades.rows) {
      try {
        const priceData = prices[trade.instrument]
        if (!priceData) continue

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const demo_pnl = calculateServerPnL(
          trade.direction,
          parseFloat(trade.open_price),
          close_price,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const locked = await client.query(
            `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
            [trade.id]
          )
          if (locked.rows.length === 0) { await client.query('ROLLBACK'); continue }

          await client.query(
            `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(),
             demo_pnl = $2, close_reason = 'Weekend Close' WHERE id = $3`,
            [close_price, demo_pnl, trade.id]
          )
          await client.query(
            `UPDATE accounts SET
               current_balance = current_balance + $1,
               peak_balance    = GREATEST(peak_balance, current_balance + $1)
             WHERE id = $2`,
            [demo_pnl, trade.account_id]
          )
          await client.query('COMMIT')
        } catch (txErr) {
          await client.query('ROLLBACK')
          logger.error(`[weekend_close] Trade ${trade.id} error:`, { error: txErr.message })
        } finally {
          client.release()
        }
      } catch (tradeErr) {
        closeErrors += 1
        logger.error(`[weekend_close] Error on trade ${trade.id}:`, { error: tradeErr.message })
      }
    }

    for (const order of pendingOrders.rows) {
      try {
        await pool.query(
          `UPDATE trades
           SET status = 'cancelled',
               close_time = NOW(),
               close_reason = 'Weekend holding disabled'
           WHERE id = $1 AND status = 'pending'`,
          [order.id]
        )
      } catch (orderErr) {
        closeErrors += 1
        logger.error(`[weekend_close] Error on pending order ${order.id}:`, { error: orderErr.message })
      }
    }

    const uniqueUsers = [...new Set([
      ...openTrades.rows.map(t => t.user_id),
      ...pendingOrders.rows.map(t => t.user_id)
    ])]
    for (const userId of uniqueUsers) {
      io.to(String(userId)).emit('account_update', {
        event:   'weekend_close',
        message: '🔦 Weekend holding is disabled. Open positions were closed and pending orders were cancelled before the weekend.'
      })
    }

    logger.info('[weekend_close] Completed:', { tradesClosed: openTrades.rows.length, pendingCancelled: pendingOrders.rows.length })
    if (closeErrors === 0) weekendCloseExecutedDate = todayKey
  } catch (error) {
    logger.error('[weekend_close] Error:', { error: error.message })
  }
}

async function weekendForceCloseByTenant() {
  try {
    const now = new Date()
    const dayUTC = now.getUTCDay()
    const hourUTC = now.getUTCHours()
    const minuteUTC = now.getUTCMinutes()

    if (dayUTC !== 5) return
    const inWindow = hourUTC === 21 && minuteUTC < 10
    if (!inWindow) return

    const todayKey = now.toISOString().slice(0, 10)
    if (weekendCloseExecutedDate === todayKey) return

    const openTrades = await pool.query(
      `SELECT t.*, a.user_id, a.tenant_id
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.status = 'open'`
    )
    const pendingOrders = await pool.query(
      `SELECT t.id, t.account_id, t.instrument, t.order_type, a.user_id, a.tenant_id
         FROM trades t
         JOIN accounts a ON t.account_id = a.id
        WHERE t.status = 'pending'`
    )
    if (openTrades.rows.length === 0 && pendingOrders.rows.length === 0) return

    const tenantIds = [...new Set([
      ...openTrades.rows.map((trade) => parseInt(trade.tenant_id, 10) || 1),
      ...pendingOrders.rows.map((order) => parseInt(order.tenant_id, 10) || 1)
    ])]
    const tenantRules = new Map()
    for (const tenantId of tenantIds) {
      tenantRules.set(String(tenantId), await getTradingRules(tenantId))
    }

    const filteredOpenTrades = openTrades.rows.filter((trade) => tenantRules.get(String(trade.tenant_id || 1))?.weekendHoldingEnabled === false)
    const filteredPendingOrders = pendingOrders.rows.filter((order) => tenantRules.get(String(order.tenant_id || 1))?.weekendHoldingEnabled === false)
    if (filteredOpenTrades.length === 0 && filteredPendingOrders.length === 0) return

    logger.info(`[weekend_close] Friday 21:00-21:09 UTC - flattening ${filteredOpenTrades.length} open trade(s) and cancelling ${filteredPendingOrders.length} pending order(s)`)

    const tenantPriceCache = new Map()
    let closeErrors = 0

    for (const trade of filteredOpenTrades) {
      try {
        const tenantKey = String(trade.tenant_id || 1)
        if (!tenantPriceCache.has(tenantKey)) {
          tenantPriceCache.set(tenantKey, await getCurrentPricesForTenant(trade.tenant_id || 1))
        }
        const priceData = tenantPriceCache.get(tenantKey)?.[trade.instrument]
        if (!priceData) continue

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const demo_pnl = calculateServerPnL(
          trade.direction,
          parseFloat(trade.open_price),
          close_price,
          parseFloat(trade.lot_size),
          trade.instrument,
          parseFloat(trade.commission || 0)
        )

        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          const locked = await client.query(
            `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
            [trade.id]
          )
          if (locked.rows.length === 0) { await client.query('ROLLBACK'); continue }

          await client.query(
            `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(),
             demo_pnl = $2, close_reason = 'Weekend Close' WHERE id = $3`,
            [close_price, demo_pnl, trade.id]
          )
          await client.query(
            `UPDATE accounts SET
               current_balance = current_balance + $1,
               peak_balance = GREATEST(peak_balance, current_balance + $1)
             WHERE id = $2`,
            [demo_pnl, trade.account_id]
          )
          await client.query('COMMIT')
        } catch (txErr) {
          await client.query('ROLLBACK')
          logger.error(`[weekend_close] Trade ${trade.id} error:`, { error: txErr.message })
        } finally {
          client.release()
        }
      } catch (tradeErr) {
        closeErrors += 1
        logger.error(`[weekend_close] Error on trade ${trade.id}:`, { error: tradeErr.message })
      }
    }

    for (const order of filteredPendingOrders) {
      try {
        await pool.query(
          `UPDATE trades
              SET status = 'cancelled',
                  close_time = NOW(),
                  close_reason = 'Weekend holding disabled'
            WHERE id = $1 AND status = 'pending'`,
          [order.id]
        )
      } catch (orderErr) {
        closeErrors += 1
        logger.error(`[weekend_close] Error on pending order ${order.id}:`, { error: orderErr.message })
      }
    }

    const uniqueUsers = [...new Set([
      ...filteredOpenTrades.map((trade) => trade.user_id),
      ...filteredPendingOrders.map((order) => order.user_id)
    ])]
    for (const userId of uniqueUsers) {
      io.to(String(userId)).emit('account_update', {
        event: 'weekend_close',
        message: 'Weekend holding is disabled. Open positions were closed and pending orders were cancelled before the weekend.'
      })
    }

    logger.info('[weekend_close] Completed:', {
      tradesClosed: filteredOpenTrades.length,
      pendingCancelled: filteredPendingOrders.length
    })
    if (closeErrors === 0) weekendCloseExecutedDate = todayKey
  } catch (error) {
    logger.error('[weekend_close] Error:', { error: error.message })
  }
}
registerTrackedInterval(() => {
  runLockedSchedulerJob('jobs:weekend_force_close', 'weekend_force_close', weekendForceCloseByTenant)
}, 60 * 1000)

// ── Global error handler (must be last, 4 args) ───────────────────────────────
app.use(function(err, req, res, next) { // eslint-disable-line no-unused-vars
  logger.error('Unhandled error:', { 
    method: req.method, 
    path: req.path, 
    error: err.message, 
    stack: err.stack,
    ip: req.ip,
    userAgent: req.get('User-Agent')
  })
  if (res.headersSent) return
  
  // Don't expose stack traces in production
  const errorResponse = process.env.NODE_ENV === 'production' 
    ? { error: 'Internal server error' }
    : { error: err.message || 'Internal server error', stack: err.stack }
    
  res.status(err.status || 500).json(errorResponse)
})

const PORT = process.env.PORT || 5000

// FIX (C2): Initialize Redis for token caching on startup
async function startServer() {
  try {
    // Initialize Redis cache for token validation (improves performance by 100x)
    // Fails gracefully - authentication still works via DB if Redis unavailable
    await initializeRedis()
    await initializeKafka()
    
    httpServer.listen(PORT, function() {
      logger.info('Server started:', { port: PORT, env: process.env.NODE_ENV || 'development' })
    })

    // Graceful shutdown
    async function gracefulShutdown(signal) {
      if (shutdownInProgress) {
        logger.warn(`${signal} received while shutdown is already in progress`)
        return
      }

      shutdownInProgress = true
      logger.info(`${signal} received, shutting down gracefully...`)

      const forceExitTimer = setTimeout(() => {
        logger.error('Graceful shutdown timed out; forcing process exit')
        for (const socket of activeHttpSockets) {
          try {
            socket.destroy()
          } catch {}
        }
        process.exit(1)
      }, 10000)
      if (typeof forceExitTimer.unref === 'function') {
        forceExitTimer.unref()
      }

      clearTrackedTimers()

      try {
        newsService.stop?.()
      } catch (error) {
        logger.warn('Failed to stop news service cleanly', { error: error.message })
      }

      try {
        stopPriceFeedWatchers?.()
      } catch (error) {
        logger.warn('Failed to stop price feed watchers cleanly', { error: error.message })
      }

      try {
        await new Promise((resolve) => io.close(() => resolve()))
      } catch (error) {
        logger.warn('Socket.IO close error during shutdown', { error: error.message })
      }

      for (const socket of activeHttpSockets) {
        try {
          socket.end()
        } catch {}
      }

      const destroyLingeringSocketsTimer = setTimeout(() => {
        for (const socket of activeHttpSockets) {
          try {
            socket.destroy()
          } catch {}
        }
      }, 2000)
      if (typeof destroyLingeringSocketsTimer.unref === 'function') {
        destroyLingeringSocketsTimer.unref()
      }

      try {
        await new Promise((resolve, reject) => {
          httpServer.close((error) => {
            if (error) {
              reject(error)
              return
            }
            logger.info('Server closed')
            resolve()
          })
        })
      } catch (error) {
        logger.warn('HTTP server close error during shutdown', { error: error.message })
      }

      clearTimeout(destroyLingeringSocketsTimer)

      await Promise.allSettled([
        closeRedis(),
        closeKafka(),
        pool.end()
      ])

      clearTimeout(forceExitTimer)
      process.exit(0)
    }

    process.once('SIGTERM', () => gracefulShutdown('SIGTERM'))
    process.once('SIGINT',  () => gracefulShutdown('SIGINT'))

    // FIX (BUG-H001): Prevent silent crashes from unhandled promise rejections
    // and uncaught exceptions in Node 15+ where they terminate the process.
    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled promise rejection:', { error: reason?.message || String(reason) })
    })
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception:', { error: err.message, stack: err.stack })
      process.exit(1)
    })
  } catch (err) {
    logger.error('Failed to start server:', { error: err.message })
    process.exit(1)
  }
}

startServer()

module.exports = { app, io }
