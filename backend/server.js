// NOTE: All date operations should use UTC methods (getUTC*, setUTC*)
// to ensure consistent behavior across timezones
require('./loadEnv')

// ── Sentry must be initialized FIRST, before any other requires ───────────────
const { initSentry, sentryRequestHandler, sentryTracingHandler, sentryErrorHandler, flushSentry, captureException } = require('./utils/sentry')
initSentry()

const express = require('express')
const cors = require('cors')
const cookieParser = require('cookie-parser')
const path = require('path')
const { createServer } = require('http')
const pool = require('./db')
const { Server } = require('socket.io')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const Decimal = require('decimal.js')
const { CONTRACT_SIZES } = require('./constants')
const { securityHeaders, apiLimiter, abuseDetector } = require('./utils/security')
const { securityMonitor } = require('./config/security-config')
const logger = require('./utils/logger')
const { initializeRedis, closeRedis } = require('./utils/tokenCache')
const { initializeKafka, closeKafka } = require('./utils/kafka')
const { performanceMonitor, wrapDatabaseQuery, getMetrics, resetMetrics, getHealthStatus } = require('./utils/performance')
const { getFeedHealthForTenant, getLaunchHealthStatus } = require('./utils/launchReadiness')
const { registerIO } = require('./utils/realtime')
const {
  ensureTenantSettingsInfrastructure
} = require('./utils/tenantSettings')
const { ensureIdempotencyInfrastructure } = require('./utils/idempotency')
const { ensureEmailQueueInfrastructure } = require('./utils/emailQueue')
const { sanitizeString } = require('./utils/validation')
const { isAllowedOrigin } = require('./utils/allowedOrigins')
const { generateTraderUid } = require('./utils/traderIds')
const { generateAccountUid } = require('./utils/accountIds')

// ── Services (extracted from the old monolithic server.js) ────────────────────
const { configureSocket } = require('./services/socketService')
const { startPriceFeedPipeline } = require('./services/priceBroadcast')
const {
  registerTrackedInterval,
  registerTrackedTimeout,
  clearTrackedTimers,
  startAllSchedulers
} = require('./services/schedulerService')
const {
  checkNewsForceClose,
  startNewsService,
  stopNewsService,
  setIo: setNewsIo
} = require('./services/newsCloseService')
const {
  weekendForceCloseByTenant,
  setIo: setWeekendIo
} = require('./services/weekendCloseService')
const {
  flatByCloseForAccounts,
  setIo: setFlatByCloseIo
} = require('./services/flatByCloseService')

// ── Price feed ────────────────────────────────────────────────────────────────
const {
  stopPriceFeedWatchers
} = require('./priceFeed')

// ── Route files ───────────────────────────────────────────────────────────────
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
const adminRoutes          = require('./routes/admin')
const adminViolationRoutes = require('./routes/adminViolations')
const adminAnalyticsRoutes = require('./routes/adminAnalytics')
const adminCompetitionRoutes = require('./routes/adminCompetitions')
const adminTradingEconomicsRoutes = require('./routes/adminTradingEconomics')
const competitionRoutes    = require('./routes/competitions')
const adminAffiliateRoutes = require('./routes/adminAffiliates')
const adminCouponRoutes    = require('./routes/adminCoupons')
const affiliateRoutes      = require('./routes/affiliates')
const payoutRoutes         = require('./routes/payouts')
const kycRoutes            = require('./routes/kyc')
const chatRoutes           = require('./routes/chat')
const swaggerRoutes        = require('./routes/swagger')
const { router: billingRoutes, billingWebhookHandler, ensureBillingInfrastructure } = require('./routes/billing')
const {
  authenticateToken: authTok,
  authenticateAdmin: authAdm,
  requireSuperAdmin
} = require('./routes/middleware')
const { runChallengeEngine } = require('./challengeEngine')
const { runCompetitionEngine } = require('./competitionEngine')
const { tickCompetitionBots } = require('./services/competitionBotService')
const { validateEnv } = require('./env')
const { ensureChatTables } = require('./routes/chat')

// ─────────────────────────────────────────────────────────────────────────────
validateEnv()

// ─── Utility functions kept in server.js (not large enough to extract) ────────
function resolveTrustProxySetting() {
  const raw = process.env.TRUST_PROXY
  if (raw == null || String(raw).trim() === '') {
    return process.env.NODE_ENV === 'production' ? 1 : false
  }
  const normalized = String(raw).trim().toLowerCase()
  if (['false', '0', 'off', 'no'].includes(normalized)) return false
  if (['true', '1', 'on', 'yes'].includes(normalized)) return 1
  if (/^\d+$/.test(normalized)) return parseInt(normalized, 10)
  return String(raw).trim()
}

function calculateServerPnL(direction, open_price, close_price, lots, instrument, commission = 0) {
  const contractSize = new Decimal(CONTRACT_SIZES[instrument] || 100000)
  const priceDiff = direction === 'buy'
    ? new Decimal(close_price).minus(open_price)
    : new Decimal(open_price).minus(close_price)
  return priceDiff.times(lots).times(contractSize).minus(commission).toDecimalPlaces(2).toNumber()
}

async function getAnnouncementState() {
  const result = await pool.query(
    `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
    [['announcement_message', 'announcement_type', 'announcement_enabled', 'announcement_updated_at']]
  )
  const settings = {}
  for (const row of result.rows) settings[row.key] = row.value
  const message = sanitizeString(String(settings.announcement_message || ''), 500)
  const rawType = String(settings.announcement_type || 'info').toLowerCase()
  const type = ['info', 'success', 'warning', 'error'].includes(rawType) ? rawType : 'info'
  const enabled = message.length > 0 && String(settings.announcement_enabled || 'true').toLowerCase() !== 'false'
  return { message, type, enabled, updated_at: settings.announcement_updated_at || null }
}

async function fetchLeaderboardRows({ includeHidden = false, limit = 20 }) {
  const result = await pool.query(
    `
      WITH ranked_accounts AS (
        SELECT
          u.id AS user_id, u.full_name, u.country, u.trader_uid,
          COALESCE(u.leaderboard_visible, TRUE) AS visible,
          a.account_uid, a.account_size,
          ROUND((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0))::numeric, 2) AS profit_usd,
          ROUND(
            CASE WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
              ELSE ((COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance) * 100
            END::numeric, 2
          ) AS profit_pct,
          ROW_NUMBER() OVER (
            PARTITION BY u.id
            ORDER BY
              CASE WHEN COALESCE(a.starting_balance, 0) = 0 THEN 0
                ELSE (COALESCE(a.current_balance, 0) - COALESCE(a.starting_balance, 0)) / a.starting_balance
              END DESC,
              a.current_balance DESC, a.id DESC
          ) AS rn
        FROM users u
        JOIN accounts a ON a.user_id = u.id
        WHERE a.account_type = 'funded' AND a.status = 'active'
          AND COALESCE(u.is_banned, FALSE) = FALSE
      ),
      closed_trade_stats AS (
        SELECT
          a.user_id,
          COUNT(t.id)::int AS total_trades,
          COALESCE(ROUND(
            CASE WHEN COUNT(t.id) = 0 THEN 0
              ELSE (100.0 * COUNT(t.id) FILTER (WHERE t.demo_pnl > 0) / COUNT(t.id))
            END::numeric, 1
          ), 0) AS win_rate
        FROM accounts a
        LEFT JOIN trades t ON t.account_id = a.id AND t.status = 'closed'
        GROUP BY a.user_id
      )
      SELECT r.user_id, r.full_name, r.country, r.trader_uid, r.visible,
             r.account_uid, r.account_size, r.profit_usd, r.profit_pct,
             COALESCE(s.total_trades, 0) AS total_trades, COALESCE(s.win_rate, 0) AS win_rate
      FROM ranked_accounts r
      LEFT JOIN closed_trade_stats s ON s.user_id = r.user_id
      WHERE r.rn = 1 AND ($1::boolean = TRUE OR r.visible = TRUE)
      ORDER BY r.profit_pct DESC, r.profit_usd DESC, r.user_id ASC
      LIMIT $2
    `,
    [includeHidden, limit]
  )
  return result.rows.map((row, index) => ({
    ...row, rank: index + 1,
    profit_pct: parseFloat(row.profit_pct || 0),
    profit_usd: parseFloat(row.profit_usd || 0),
    account_size: parseFloat(row.account_size || 0),
    total_trades: parseInt(row.total_trades || 0, 10),
    win_rate: parseFloat(row.win_rate || 0),
    visible: row.visible !== false
  }))
}

async function ensureUniqueIds() {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trader_uid TEXT`)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_trader_uid_uq ON users(trader_uid)`)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS leaderboard_visible BOOLEAN NOT NULL DEFAULT TRUE`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_uid TEXT`)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_uid_uq ON accounts(account_uid)`)
    // Sequence tables for generateAccountUid/generateTraderUid (utils/accountIds.js,
    // utils/traderIds.js) — created here too (not just in their migrations) so the
    // backfill loops below never race against migrations not having run yet.
    await pool.query(`CREATE TABLE IF NOT EXISTS account_id_sequences (category TEXT PRIMARY KEY, last_value INTEGER NOT NULL DEFAULT 0)`)
    await pool.query(`CREATE TABLE IF NOT EXISTS trader_id_sequences (id INTEGER PRIMARY KEY, last_value INTEGER NOT NULL DEFAULT 0)`)
    await pool.query(`CREATE TABLE IF NOT EXISTS bbook_pnl (
      date              DATE PRIMARY KEY,
      accounts_passed   INT NOT NULL DEFAULT 0,
      accounts_failed   INT NOT NULL DEFAULT 0,
      accounts_expired  INT NOT NULL DEFAULT 0,
      new_funded        INT NOT NULL DEFAULT 0
    )`)
    await pool.query(`CREATE INDEX IF NOT EXISTS bbook_pnl_date_idx ON bbook_pnl(date DESC)`)
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
        trade_id    TEXT,
        user_id     TEXT,
        account_id  TEXT,
        ip_address  TEXT,
        logged_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'trade_logs' AND column_name = 'trade_id' AND data_type <> 'text'
        ) THEN ALTER TABLE trade_logs ALTER COLUMN trade_id TYPE TEXT USING trade_id::text; END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'trade_logs' AND column_name = 'user_id' AND data_type <> 'text'
        ) THEN ALTER TABLE trade_logs ALTER COLUMN user_id TYPE TEXT USING user_id::text; END IF;
        IF EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_name = 'trade_logs' AND column_name = 'account_id' AND data_type <> 'text'
        ) THEN ALTER TABLE trade_logs ALTER COLUMN account_id TYPE TEXT USING account_id::text; END IF;
      END $$;
    `)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_logs (
        id           BIGSERIAL PRIMARY KEY,
        user_id      TEXT,
        ip_address   TEXT,
        logged_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    // FIX (BUG-M5): support_tickets DDL moved from inline route handlers to startup.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_tickets (
        id          BIGSERIAL PRIMARY KEY,
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
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_ticket_messages (
        id          BIGSERIAL PRIMARY KEY,
        ticket_id   BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'admin')),
        sender_name TEXT,
        message     TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)
    await pool.query(`CREATE INDEX IF NOT EXISTS support_ticket_messages_ticket_idx ON support_ticket_messages(ticket_id, created_at ASC)`)
    await pool.query(`CREATE INDEX IF NOT EXISTS support_tickets_created_idx ON support_tickets(created_at DESC)`)
    const users = await pool.query(`SELECT id FROM users WHERE trader_uid IS NULL ORDER BY created_at ASC`)
    for (const row of users.rows) {
      const trader_uid = await generateTraderUid(pool)
      await pool.query(`UPDATE users SET trader_uid = $1 WHERE id = $2`, [trader_uid, row.id])
    }
    const accounts = await pool.query(`SELECT id, account_type, challenge_model_slug FROM accounts WHERE account_uid IS NULL ORDER BY created_at ASC`)
    for (const row of accounts.rows) {
      const account_uid = await generateAccountUid(pool, { accountType: row.account_type, challengeModelSlug: row.challenge_model_slug })
      await pool.query(`UPDATE accounts SET account_uid = $1 WHERE id = $2`, [account_uid, row.id])
    }
  } catch (err) {
    logger.warn('[startup] Failed to backfill unique IDs:', { error: err.message })
  }
}

async function ensureDisputesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS disputes (
      id             BIGSERIAL PRIMARY KEY,
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
  await pool.query(`CREATE INDEX IF NOT EXISTS disputes_created_idx ON disputes(created_at DESC)`)
}

// ─── Startup infrastructure ───────────────────────────────────────────────────
ensureUniqueIds().catch(err => {
  logger.error('[startup] Failed to ensure unique ids/infrastructure:', { error: err.message })
})
pool.query(`ALTER TABLE trades ADD COLUMN IF NOT EXISTS original_commission NUMERIC(10,2)`).catch(err => {
  logger.warn('[startup] Could not add original_commission column:', { error: err.message })
})
ensureChatTables().catch(err => {
  logger.error('[startup] Failed to ensure chat tables:', { error: err.message })
})
ensureBillingInfrastructure().catch(err => {
  logger.error('[startup] Failed to ensure billing infrastructure:', { error: err.message })
})
ensureTradeExperienceInfrastructure().catch(err => {
  logger.error('[startup] Failed to ensure trade experience infrastructure:', { error: err.message })
})
ensureIdempotencyInfrastructure().catch(err => {
  logger.error('[startup] Failed to ensure idempotency infrastructure:', { error: err.message })
})
ensureEmailQueueInfrastructure().catch(err => {
  logger.error('[startup] Failed to ensure email queue infrastructure:', { error: err.message })
})
ensureDisputesTable().catch(err => {
  logger.error('[startup] Failed to ensure disputes table:', { error: err.message })
})

// ─── Express + Socket.IO setup ────────────────────────────────────────────────
const app = express()
const httpServer = createServer(app)
const trustProxySetting = resolveTrustProxySetting()
app.set('trust proxy', trustProxySetting)
logger.info('[startup] Express trust proxy configured', { trustProxy: trustProxySetting })

app.use(securityHeaders)
app.use(abuseDetector)
app.use(performanceMonitor)
app.use(apiLimiter)
app.use(securityMonitor.checkAttackPatterns)

// Rate limiters
const authLimiter    = rateLimit({ windowMs: 1 * 60 * 1000,  max: 10, message: { error: 'Too many attempts. Wait 1 minute.' },                    standardHeaders: true, legacyHeaders: false })
const supportLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Too many support requests. Wait before retrying.' },    standardHeaders: true, legacyHeaders: false })
const trackLimiter   = rateLimit({ windowMs: 60 * 1000,      max: 20, message: { error: 'Too many tracking events.' },                          standardHeaders: true, legacyHeaders: false })

const io = new Server(httpServer, {
  cors: {
    origin: function (origin, callback) {
      callback(null, isAllowedOrigin(origin) ? (origin || true) : false)
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
})

// ── Socket.IO — auth middleware + connection handler (extracted to services) ──
configureSocket(io, pool)
setNewsIo(io)
setWeekendIo(io)
setFlatByCloseIo(io)

// ── HTTP socket tracking (for graceful shutdown) ──────────────────────────────
const activeHttpSockets = new Set()
let shutdownInProgress = false
httpServer.on('connection', (socket) => {
  activeHttpSockets.add(socket)
  socket.on('close', () => { activeHttpSockets.delete(socket) })
})

// ─── Express middleware ───────────────────────────────────────────────────────
app.use(sentryRequestHandler())
app.use(sentryTracingHandler())

app.use(helmet({
  contentSecurityPolicy: process.env.NODE_ENV === 'production' ? { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://s3.tradingview.com'], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:', 'https:'], connectSrc: ["'self'", 'wss:'], fontSrc: ["'self'"], frameSrc: ['https://www.tradingview.com', 'https://s.tradingview.com', 'https://www.tradingview-widget.com'], objectSrc: ["'none'"], upgradeInsecureRequests: [] } } : false,
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  frameguard: { action: 'deny' },
  referrerPolicy: { policy: 'no-referrer' },
  permissionsPolicy: { geolocation: [], microphone: [], camera: [] }
}))
app.use(cors({
  origin: function (origin, callback) {
    callback(null, isAllowedOrigin(origin) ? (origin || true) : false)
  },
  credentials: true
}))
app.post('/api/billing/stripe/webhook', express.raw({ type: 'application/json' }), billingWebhookHandler)
app.use(express.json({ limit: '1mb' }))
app.use(cookieParser())
app.disable('x-powered-by')
app.use(logger.httpMiddleware)

// ─── Secure uploads ───────────────────────────────────────────────────────────
const uploadsRoot = path.resolve(__dirname, 'uploads')
app.use('/uploads', authAdm, function (req, res) {
  const relPath = req.path.replace(/^\/+/, '')
  const absPath = path.resolve(uploadsRoot, relPath)
  if (!absPath.startsWith(uploadsRoot + path.sep) && absPath !== uploadsRoot) {
    return res.status(400).json({ error: 'Invalid path' })
  }
  res.sendFile(absPath, function (err) {
    if (err) res.status(err.statusCode || 404).json({ error: 'File not found' })
  })
})

wrapDatabaseQuery(pool)

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/setup',    require('./routes/setup'))
app.use('/api/auth',     authLimiter,   authRoutes)
app.use('/api/docs',     swaggerRoutes)
app.use('/api/accounts', accountRoutes)
app.use('/api/trades',   tradeRoutes)
app.use('/api/admin',    adminRoutes)
app.use('/api/admin',    adminViolationRoutes)
app.use('/api/admin',    adminAnalyticsRoutes)
app.use('/api/admin',    adminCompetitionRoutes)
app.use('/api/admin',    adminTradingEconomicsRoutes)
app.use('/api/admin',    adminAffiliateRoutes)
app.use('/api/admin',    adminCouponRoutes)
app.use('/api/competitions', competitionRoutes)
app.use('/api/affiliates', affiliateRoutes)
app.use('/api/payouts',  payoutRoutes)
app.use('/api/kyc',      kycRoutes)
app.use('/api/chat',     chatRoutes)
app.use('/api/disputes', require('./routes/disputes'))
app.use('/api/billing',  billingRoutes)
app.use('/api/transparency', require('./routes/transparency'))

// ─── Performance & Health endpoints ──────────────────────────────────────────
app.get('/api/health', async function (req, res) {
  try {
    res.json(await getLaunchHealthStatus())
  } catch (error) {
    logger.error('Health endpoint error:', { error: error.message })
    res.status(503).json({ ...getHealthStatus(), status: 'unhealthy', launch_ready: false, error: 'Could not build launch health summary' })
  }
})
app.get('/api/metrics', authAdm, requireSuperAdmin, function (req, res) { res.json(getMetrics()) })
app.post('/api/metrics/reset', authAdm, requireSuperAdmin, function (req, res) { resetMetrics(); res.json({ message: 'Metrics reset successfully' }) })

app.get('/api/announcement', async function (req, res) {
  try {
    const announcement = await getAnnouncementState()
    if (!announcement.enabled) return res.json(null)
    res.json({ message: announcement.message, type: announcement.type, updated_at: announcement.updated_at })
  } catch (error) {
    logger.error('Public announcement error:', { error: error.message })
    res.status(500).json({ error: 'Could not load announcement' })
  }
})

app.get('/api/leaderboard', async function (req, res) {
  try {
    res.json(await fetchLeaderboardRows({ includeHidden: false, limit: 20 }))
  } catch (error) {
    logger.error('Leaderboard error:', { error: error.message })
    res.status(500).json({ error: 'Could not load leaderboard' })
  }
})

// ── Marketing funnel tracking (public, unauthenticated) ───────────────────────
// Fire-and-forget "visit" events from the public Landing page — the only
// pre-registration funnel stage this platform ever tracked was none at all;
// this is deliberately minimal (no PII, no fingerprinting), just a count.
app.post('/api/analytics/track', trackLimiter, async function (req, res) {
  try {
    const eventType = ['visit'].includes(req.body?.event_type) ? req.body.event_type : 'visit'
    const sessionId = req.body?.session_id ? sanitizeString(String(req.body.session_id), 100) : null
    await pool.query(
      `INSERT INTO marketing_funnel_events (event_type, session_id) VALUES ($1, $2)`,
      [eventType, sessionId]
    )
    res.status(201).json({ ok: true })
  } catch (error) {
    // Best-effort — tracking must never break the page for a visitor.
    res.status(200).json({ ok: false })
  }
})

// ── Support tickets (user-facing + admin-facing) ──────────────────────────────
app.post('/api/support/ticket', supportLimiter, function optionalAuth(req, res, next) {
  const jwtLib = require('jsonwebtoken')
  const token = req.cookies?.token || (req.headers.authorization || '').split(' ')[1]
  if (token) { try { req.user = jwtLib.verify(token, process.env.JWT_SECRET) } catch {} }
  next()
}, async function (req, res) {
  try {
    const { category, email, name } = req.body
    const subject = sanitizeString(String(req.body?.subject || ''), 200)
    const message = sanitizeString(String(req.body?.message || ''), 5000)
    const user_id = req.user?.userId
    if (!subject || !message) return res.status(400).json({ error: 'Subject and message are required' })
    await pool.query(
      `INSERT INTO support_tickets (user_id, email, name, category, subject, message, sla_due_at) VALUES ($1, $2, $3, $4, $5, $6, NOW() + INTERVAL '24 hours')`,
      [user_id || null, sanitizeString(String(email || ''), 200), sanitizeString(String(name || ''), 100), category || 'other', subject, message]
    )
    res.status(201).json({ message: 'Support ticket submitted successfully' })
  } catch (error) {
    logger.error('Support ticket error:', { error: error.message })
    res.status(500).json({ error: 'Could not submit support ticket' })
  }
})

async function loadUserSupportTickets(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, category, subject, message, status, created_at FROM support_tickets WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.userId]
    )
    res.json(result.rows)
  } catch (error) {
    logger.error('Load support tickets error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch tickets' })
  }
}

app.get('/api/support/tickets',    authTok, loadUserSupportTickets)
app.get('/api/support/my-tickets', authTok, loadUserSupportTickets)

app.get('/api/support/ticket/:id', authTok, async function (req, res) {
  try {
    const ticketId = parseInt(req.params.id, 10)
    if (!Number.isFinite(ticketId)) return res.status(400).json({ error: 'Invalid ticket id' })
    const ticketResult = await pool.query(
      `SELECT id, user_id, category, subject, message, status, created_at FROM support_tickets WHERE id = $1 AND user_id = $2`,
      [ticketId, req.user.userId]
    )
    if (ticketResult.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' })
    const messagesResult = await pool.query(
      `SELECT id, sender_type, sender_name, message, created_at FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC, id ASC`,
      [ticketId]
    )
    res.json({ ticket: ticketResult.rows[0], messages: messagesResult.rows })
  } catch (error) {
    logger.error('Load support ticket detail error:', { error: error.message })
    res.status(500).json({ error: 'Could not load ticket thread' })
  }
})

app.post('/api/support/ticket/:id/reply', authTok, async function (req, res) {
  try {
    const ticketId = parseInt(req.params.id, 10)
    if (!Number.isFinite(ticketId)) return res.status(400).json({ error: 'Invalid ticket id' })
    const message = sanitizeString(String(req.body?.message || ''), 2000)
    if (!message) return res.status(400).json({ error: 'Reply message is required' })
    const ticketResult = await pool.query(
      `SELECT id, status FROM support_tickets WHERE id = $1 AND user_id = $2`,
      [ticketId, req.user.userId]
    )
    if (ticketResult.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' })
    if (ticketResult.rows[0].status === 'closed') return res.status(400).json({ error: 'Closed tickets cannot receive new replies' })
    const replyResult = await pool.query(
      `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_name, message) VALUES ($1, 'user', $2, $3) RETURNING id, sender_type, sender_name, message, created_at`,
      [ticketId, 'You', message]
    )
    res.status(201).json({ message: 'Reply sent successfully', reply: replyResult.rows[0] })
  } catch (error) {
    logger.error('Support ticket reply error:', { error: error.message })
    res.status(500).json({ error: 'Could not send reply' })
  }
})

app.get('/api/admin/support-tickets', authAdm, async function (req, res) {
  try {
    const result = await pool.query(
      `SELECT * FROM support_tickets ORDER BY created_at DESC`
    )
    res.json(result.rows)
  } catch (error) { res.status(500).json({ error: 'Could not fetch tickets' }) }
})

app.patch('/api/admin/support-tickets/:id', authAdm, async function (req, res) {
  try {
    const { status, assigned_agent, internal_notes } = req.body
    const sets = []
    const values = []
    if (status !== undefined) {
      if (!['open', 'resolved', 'closed'].includes(status)) return res.status(400).json({ error: 'Invalid status' })
      values.push(status)
      sets.push(`status = $${values.length}`)
    }
    if (assigned_agent !== undefined) {
      values.push(sanitizeString(String(assigned_agent || ''), 100) || null)
      sets.push(`assigned_agent = $${values.length}`)
    }
    if (internal_notes !== undefined) {
      values.push(sanitizeString(String(internal_notes || ''), 5000) || null)
      sets.push(`internal_notes = $${values.length}`)
    }
    if (sets.length === 0) return res.status(400).json({ error: 'Nothing to update' })
    values.push(req.params.id)
    const result = await pool.query(
      `UPDATE support_tickets SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING *`,
      values
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' })
    res.json({ message: 'Ticket updated', ticket: result.rows[0] })
  } catch (error) { res.status(500).json({ error: 'Could not update ticket' }) }
})

app.get('/api/admin/support-tickets/:id', authAdm, async function (req, res) {
  try {
    const ticketId = parseInt(req.params.id, 10)
    if (!Number.isFinite(ticketId)) return res.status(400).json({ error: 'Invalid ticket id' })
    const ticketResult = await pool.query(`SELECT * FROM support_tickets WHERE id = $1`, [ticketId])
    if (ticketResult.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' })
    const messagesResult = await pool.query(
      `SELECT id, sender_type, sender_name, message, created_at FROM support_ticket_messages WHERE ticket_id = $1 ORDER BY created_at ASC, id ASC`,
      [ticketId]
    )
    res.json({ ticket: ticketResult.rows[0], messages: messagesResult.rows })
  } catch (error) {
    logger.error('Admin support ticket detail error:', { error: error.message })
    res.status(500).json({ error: 'Could not load ticket thread' })
  }
})

app.post('/api/admin/support-tickets/:id/reply', authAdm, async function (req, res) {
  try {
    const ticketId = parseInt(req.params.id, 10)
    if (!Number.isFinite(ticketId)) return res.status(400).json({ error: 'Invalid ticket id' })
    const message = sanitizeString(String(req.body?.message || ''), 2000)
    if (!message) return res.status(400).json({ error: 'Reply message is required' })
    const ticketResult = await pool.query(`SELECT id FROM support_tickets WHERE id = $1`, [ticketId])
    if (ticketResult.rows.length === 0) return res.status(404).json({ error: 'Ticket not found' })
    const senderName = req.admin?.full_name || req.admin?.email || 'Support'
    const replyResult = await pool.query(
      `INSERT INTO support_ticket_messages (ticket_id, sender_type, sender_name, message) VALUES ($1, 'admin', $2, $3) RETURNING id, sender_type, sender_name, message, created_at`,
      [ticketId, senderName, message]
    )
    res.status(201).json({ message: 'Reply sent successfully', reply: replyResult.rows[0] })
  } catch (error) {
    logger.error('Admin support ticket reply error:', { error: error.message })
    res.status(500).json({ error: 'Could not send reply' })
  }
})

// ── Disputes (user-facing + admin-facing) ─────────────────────────────────────
app.post('/api/disputes/submit', authTok, async function (req, res) {
  try {
    const { account_id } = req.body
    const reason = sanitizeString(String(req.body?.reason || ''), 200)
    const description = sanitizeString(String(req.body?.description || ''), 5000)
    const accountId = account_id === undefined || account_id === null || account_id === '' ? null : String(account_id).trim()
    if (!reason || !description?.trim()) return res.status(400).json({ error: 'reason and description are required' })
    if (description.trim().length < 30) return res.status(400).json({ error: 'Description must be at least 30 characters' })
    if (accountId !== null && !String(accountId).trim()) return res.status(400).json({ error: 'Invalid account ID' })
    if (accountId !== null) {
      const owned = await pool.query(`SELECT id FROM accounts WHERE id = $1 AND user_id = $2`, [accountId, req.user.userId])
      if (owned.rows.length === 0) return res.status(404).json({ error: 'Account not found' })
      const existing = await pool.query(`SELECT id FROM disputes WHERE user_id = $1 AND account_id = $2 AND status IN ('open','under_review')`, [req.user.userId, accountId])
      if (existing.rows.length > 0) return res.status(400).json({ error: 'You already have an open dispute for this account' })
    }
    const tradeCheck = await pool.query(
      `SELECT COUNT(*) FROM trades t JOIN accounts a ON t.account_id = a.id WHERE a.user_id = $1 AND t.status = 'closed'`,
      [req.user.userId]
    )
    if (parseInt(tradeCheck.rows[0].count) < 1) return res.status(400).json({ error: 'You must have at least one completed trade before filing a dispute.' })
    const result = await pool.query(
      `INSERT INTO disputes (user_id, account_id, reason, description) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.userId, accountId, reason, description.trim()]
    )
    res.status(201).json({ message: 'Dispute submitted', dispute: result.rows[0] })
  } catch (error) {
    logger.error('Submit dispute error:', { error: error.message })
    res.status(500).json({ error: 'Could not submit your dispute. Please try again.' })
  }
})

app.get('/api/disputes/my-disputes', authTok, async function (req, res) {
  try {
    const result = await pool.query(
      `SELECT d.*, a.account_uid, a.account_type, a.account_size FROM disputes d LEFT JOIN accounts a ON d.account_id = a.id WHERE d.user_id = $1 ORDER BY d.created_at DESC`,
      [req.user.userId]
    )
    res.json(result.rows)
  } catch (error) { res.status(500).json({ error: 'Could not load disputes.' }) }
})

app.get('/api/disputes/all', authAdm, async function (req, res) {
  try {
    const result = await pool.query(
      `SELECT d.*, u.email, u.full_name, u.trader_uid, a.account_uid, a.account_type, a.account_size, a.status as account_status FROM disputes d JOIN users u ON d.user_id = u.id LEFT JOIN accounts a ON d.account_id = a.id ORDER BY d.created_at DESC`
    )
    res.json(result.rows)
  } catch (error) { res.status(500).json({ error: 'Could not load disputes.' }) }
})

app.patch('/api/disputes/:id', authAdm, async function (req, res) {
  try {
    const { id } = req.params
    const { status, admin_response } = req.body
    const valid = ['open', 'under_review', 'resolved', 'rejected']
    if (!valid.includes(status)) return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` })
    const result = await pool.query(
      `UPDATE disputes SET status = $1, admin_response = $2, updated_at = NOW() WHERE id = $3 RETURNING *`,
      [status, admin_response || null, id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dispute not found' })
    res.json({ message: 'Dispute updated', dispute: result.rows[0] })
  } catch (error) {
    logger.error('Update dispute error:', { error: error.message })
    res.status(500).json({ error: 'Could not update dispute' })
  }
})

// ── Misc API ──────────────────────────────────────────────────────────────────
app.get('/', function (req, res) {
  res.json({ message: 'Prop Firm API running', status: 'OK', timestamp: new Date() })
})

app.get('/api/prices', async function (req, res) {
  try {
    const { getCurrentPrices } = require('./priceFeed')
    const prices = await getCurrentPrices()
    res.json(prices)
  } catch (error) {
    logger.error('Prices error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch prices' })
  }
})

app.get('/api/prices/chart/:instrument', async function (req, res) {
  try {
    const { instrument } = req.params
    const timeframeMins = Math.max(1, Math.min(parseInt(req.query.tf) || 1, 1440))
    const query = `
      SELECT
        date_trunc('minute', recorded_at) - ((EXTRACT(MINUTE FROM recorded_at)::integer % $1) || ' minutes')::interval AS bucket,
        (array_agg(bid ORDER BY recorded_at ASC))[1] as open,
        MAX(bid) as high, MIN(bid) as low,
        (array_agg(bid ORDER BY recorded_at DESC))[1] as close
      FROM price_feed_history
      WHERE instrument = $2
      GROUP BY bucket ORDER BY bucket DESC LIMIT 1000
    `
    const result = await pool.query(query, [timeframeMins, instrument])
    const formatted = result.rows.reverse().map(row => ({
      time: Math.floor(new Date(row.bucket).getTime() / 1000),
      open: parseFloat(row.open), high: parseFloat(row.high), low: parseFloat(row.low), close: parseFloat(row.close)
    }))
    res.json(formatted)
  } catch (error) {
    logger.error('Chart aggregate error:', { error: error.message })
    res.status(500).json({ error: 'Could not group chart data' })
  }
})

app.get('/api/price-status', async function (req, res) {
  try {
    res.json(await getFeedHealthForTenant())
  } catch (error) {
    logger.error('Price status error:', { error: error.message })
    res.status(500).json({ error: 'Could not check price status', healthy: false })
  }
})

// ─── Register io ──────────────────────────────────────────────────────────────
app.set('io', io)
registerIO(io)

// ─── Start price feed pipeline ────────────────────────────────────────────────
startPriceFeedPipeline(io, { registerTrackedInterval, registerTrackedTimeout })
  .catch((error) => {
    logger.error('Failed to start price feed pipeline:', { error: error.message })
  })

// ─── Start news service and schedulers ────────────────────────────────────────
startNewsService()
startAllSchedulers(io, {
  checkSLTP,
  checkPendingOrders,
  checkFloatingDrawdown,
  runChallengeEngine,
  runCompetitionEngine,
  tickCompetitionBots,
  checkNewsForceClose,
  weekendForceCloseByTenant,
  flatByCloseForAccounts,
  pruneOldPriceHistory:          require('./priceFeed').pruneOldPriceHistory,
  syncHourlyPriceHistory:        require('./priceFeed').syncHourlyPriceHistory,
  syncDedicatedPriceFeedWatchers: require('./priceFeed').syncDedicatedPriceFeedWatchers,
  processQueuedNotifications:    require('./services/notificationDeliveryService').processQueuedNotifications
})

// ─── Sentry error handler (before global handler) ─────────────────────────────
app.use(sentryErrorHandler())

// ─── Global error handler (must be last, 4 args) ─────────────────────────────
app.use(function (err, req, res, next) { // eslint-disable-line no-unused-vars
  logger.error('Unhandled error:', {
    method: req.method, path: req.path, error: err.message, stack: err.stack,
    ip: req.ip, userAgent: req.get('User-Agent')
  })
  if (res.headersSent) return
  const errorResponse = process.env.NODE_ENV === 'production'
    ? { error: 'Internal server error' }
    : { error: err.message || 'Internal server error', stack: err.stack }
  res.status(err.status || 500).json(errorResponse)
})

// ─── Server startup & graceful shutdown ───────────────────────────────────────
const PORT = process.env.PORT || 5000

async function startServer() {
  try {
    await initializeRedis()
    await initializeKafka()

    httpServer.listen(PORT, function () {
      logger.info('Server started:', { port: PORT, env: process.env.NODE_ENV || 'development' })
    })

    async function gracefulShutdown(signal) {
      if (shutdownInProgress) {
        logger.warn(`${signal} received while shutdown is already in progress`); return
      }
      shutdownInProgress = true
      logger.info(`${signal} received, shutting down gracefully...`)

      const forceExitTimer = setTimeout(() => {
        logger.error('Graceful shutdown timed out; forcing process exit')
        for (const socket of activeHttpSockets) { try { socket.destroy() } catch {} }
        process.exit(1)
      }, 10000)
      if (typeof forceExitTimer.unref === 'function') forceExitTimer.unref()

      clearTrackedTimers()
      try { stopNewsService() } catch (error) { logger.warn('Failed to stop news service cleanly', { error: error.message }) }
      try { stopPriceFeedWatchers?.() } catch (error) { logger.warn('Failed to stop price feed watchers cleanly', { error: error.message }) }
      try { await new Promise((resolve) => io.close(() => resolve())) } catch (error) { logger.warn('Socket.IO close error during shutdown', { error: error.message }) }

      for (const socket of activeHttpSockets) { try { socket.end() } catch {} }

      const destroyLingeringSocketsTimer = setTimeout(() => {
        for (const socket of activeHttpSockets) { try { socket.destroy() } catch {} }
      }, 2000)
      if (typeof destroyLingeringSocketsTimer.unref === 'function') destroyLingeringSocketsTimer.unref()

      try {
        await new Promise((resolve, reject) => {
          httpServer.close((error) => { if (error) { reject(error); return } logger.info('Server closed'); resolve() })
        })
      } catch (error) { logger.warn('HTTP server close error during shutdown', { error: error.message }) }

      clearTimeout(destroyLingeringSocketsTimer)
      await Promise.allSettled([closeRedis(), closeKafka(), pool.end(), flushSentry(3000)])
      clearTimeout(forceExitTimer)
      process.exit(0)
    }

    process.once('SIGTERM', () => gracefulShutdown('SIGTERM'))
    process.once('SIGINT',  () => gracefulShutdown('SIGINT'))

    // FIX (BUG-H001): Prevent silent crashes from unhandled promise rejections
    process.on('unhandledRejection', (reason) => {
      logger.error('Unhandled promise rejection:', { error: reason?.message || String(reason) })
      captureException(reason instanceof Error ? reason : new Error(String(reason)), { source: 'unhandledRejection' })
    })
    process.on('uncaughtException', (err) => {
      logger.error('Uncaught exception:', { error: err.message, stack: err.stack })
      captureException(err, { source: 'uncaughtException' })
      flushSentry(2000).finally(() => process.exit(1))
    })
  } catch (err) {
    logger.error('Failed to start server:', { error: err.message })
    process.exit(1)
  }
}

startServer()

module.exports = { app, io }
