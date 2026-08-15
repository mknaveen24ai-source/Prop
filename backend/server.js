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
const { readPool } = require('./db')
const { Server } = require('socket.io')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
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
const { sanitizeString } = require('./utils/validation')
const { requestContextMiddleware } = require('./utils/requestContext')
const prometheusMetrics = require('./utils/prometheusMetrics')
const { getSystemHealth } = require('./utils/systemHealth')
const { isAllowedOrigin } = require('./utils/allowedOrigins')

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
  checkFloatingDrawdown
} = require('./routes/trades')
const adminRoutes          = require('./routes/admin')
const adminViolationRoutes = require('./routes/adminViolations')
const adminAnalyticsRoutes = require('./routes/adminAnalytics')
const adminCompetitionRoutes = require('./routes/adminCompetitions')
const adminReferralSeasonRoutes = require('./routes/adminReferralSeasons')
const adminTradingEconomicsRoutes = require('./routes/adminTradingEconomics')
const competitionRoutes    = require('./routes/competitions')
const referralSeasonRoutes = require('./routes/referralSeasons')
const adminAffiliateRoutes = require('./routes/adminAffiliates')
const adminCouponRoutes    = require('./routes/adminCoupons')
const adminGiftRoutes      = require('./routes/adminGifts')
const affiliateRoutes      = require('./routes/affiliates')
const supportRoutes        = require('./routes/support')
const payoutRoutes         = require('./routes/payouts')
const kycRoutes            = require('./routes/kyc')
const chatRoutes           = require('./routes/chat')
const notificationRoutes   = require('./routes/notifications')
const swaggerRoutes        = require('./routes/swagger')
const { router: billingRoutes, billingWebhookHandler } = require('./routes/billing')
const {
  authenticateAdmin: authAdm,
  requireSuperAdmin
} = require('./routes/middleware')
const { runChallengeEngine } = require('./challengeEngine')
const { runCompetitionEngine } = require('./competitionEngine')
const { runReferralSeasonEngine } = require('./referralSeasonEngine')
const { tickCompetitionBots } = require('./services/competitionBotService')
const { validateEnv } = require('./env')

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
  // Public, uncached, and a full scan over users x accounts x trades — the
  // single heaviest read the platform serves to anonymous traffic. Runs on the
  // read pool so it cannot starve trade closes of a connection.
  const result = await readPool.query(
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

// Startup DDL lives in utils/bootstrap.js — see ensureStartupInfrastructure,
// awaited by startServer() below before httpServer.listen().
const { ensureStartupInfrastructure } = require('./utils/bootstrap')

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
// First in the chain: everything downstream, including the error handlers, then
// logs under a request id that the client also sees on X-Request-ID.
app.use(requestContextMiddleware)
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
app.use(prometheusMetrics.metricsMiddleware)

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
// The read pool is instrumented too, or the analytics queries most likely to
// be slow would be the ones missing from the slow-query log.
wrapDatabaseQuery(readPool)

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
app.use('/api/admin',    adminReferralSeasonRoutes)
app.use('/api/admin',    adminTradingEconomicsRoutes)
app.use('/api/admin',    adminAffiliateRoutes)
app.use('/api/admin',    adminCouponRoutes)
app.use('/api/admin',    adminGiftRoutes)
app.use('/api/competitions', competitionRoutes)
app.use('/api/referral-seasons', referralSeasonRoutes)
app.use('/api/affiliates', affiliateRoutes)
app.use('/api/payouts',  payoutRoutes)
app.use('/api/kyc',      kycRoutes)
app.use('/api/chat',     chatRoutes)
app.use('/api/notifications', notificationRoutes)
app.use('/api/disputes', require('./routes/disputes'))
app.use('/api/support',  supportRoutes.router)
app.use('/api/admin',    supportRoutes.adminRouter)
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

// Prometheus text format. Deliberately a separate path from /api/metrics above,
// which returns a bespoke JSON shape the admin UI already consumes.
app.get('/api/metrics/prometheus', authAdm, requireSuperAdmin, async function (req, res) {
  try {
    res.set('Content-Type', prometheusMetrics.contentType)
    res.send(await prometheusMetrics.getMetricsText())
  } catch (error) {
    logger.error('Prometheus metrics error:', { error: error.message })
    res.status(500).json({ error: 'Could not render metrics' })
  }
})

// Aggregated subsystem health for the admin dashboard. Read-only and safe to
// poll; every probe inside is individually guarded so one dead subsystem does
// not take the whole response down.
app.get('/api/admin/system-health', authAdm, async function (req, res) {
  try {
    res.json(await getSystemHealth())
  } catch (error) {
    logger.error('System health error:', { error: error.message })
    res.status(500).json({ error: 'Could not collect system health' })
  }
})

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

// ── Public landing-page stats (public, unauthenticated) ───────────────────────
// Backs the marketing site's "Live Payout Tracker" (LandingLiveStats.jsx) and
// the hero's funded-trader count — real aggregates, no PII (trader names are
// masked, same convention as routes/transparency.js).
function maskLandingTraderName(fullName, userId) {
  if (!fullName || typeof fullName !== 'string') {
    return `Trader #${String(userId || '').slice(-4).padStart(4, '0')}`
  }
  const first = fullName.trim().split(/\s+/)[0]
  if (!first) return `Trader #${String(userId || '').slice(-4).padStart(4, '0')}`
  return `${first[0].toUpperCase()}${'*'.repeat(Math.min(4, Math.max(2, first.length - 1)))}`
}

app.get('/api/public/landing-stats', async function (req, res) {
  try {
    const [payoutsResult, fundedResult, countryResult, sameDayResult, recentResult] = await Promise.all([
      pool.query(`SELECT COALESCE(SUM(amount_payable), 0) AS total, COUNT(*)::int AS count FROM payouts WHERE status = 'paid'`),
      pool.query(`SELECT COUNT(*)::int AS count FROM accounts WHERE account_type = 'funded' AND status NOT IN ('failed', 'locked')`),
      pool.query(`SELECT COUNT(DISTINCT NULLIF(TRIM(country), ''))::int AS count FROM users WHERE country IS NOT NULL AND TRIM(country) <> ''`),
      pool.query(`
        SELECT
          COUNT(*)::float AS total,
          COUNT(*) FILTER (WHERE paid_at IS NOT NULL AND requested_at IS NOT NULL AND paid_at - requested_at <= INTERVAL '24 hours')::float AS same_day
        FROM payouts WHERE status = 'paid'
      `),
      pool.query(`
        SELECT p.id, p.amount_payable, p.paid_at, u.full_name, u.country, u.id AS user_id
        FROM payouts p
        JOIN users u ON u.id::text = p.user_id::text
        WHERE p.status = 'paid' AND p.paid_at IS NOT NULL
        ORDER BY p.paid_at DESC
        LIMIT 6
      `),
    ])

    const sdRow = sameDayResult.rows[0] || {}
    const sameDayTotal = parseFloat(sdRow.total) || 0
    const sameDayRate = sameDayTotal > 0 ? Math.round((parseFloat(sdRow.same_day) / sameDayTotal) * 1000) / 10 : 0

    res.json({
      total_paid_out: parseFloat(payoutsResult.rows[0]?.total) || 0,
      paid_payout_count: payoutsResult.rows[0]?.count || 0,
      funded_trader_count: fundedResult.rows[0]?.count || 0,
      country_count: countryResult.rows[0]?.count || 0,
      same_day_payout_rate: sameDayRate,
      recent_payouts: recentResult.rows.map((row) => ({
        id: row.id,
        amount: parseFloat(row.amount_payable) || 0,
        trader_name: maskLandingTraderName(row.full_name, row.user_id),
        country: row.country || null,
        paid_at: row.paid_at,
      })),
    })
  } catch (error) {
    logger.error('Public landing stats error:', { error: error.message })
    res.status(500).json({ error: 'Could not load landing stats' })
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
// Support tickets and disputes are served entirely by routes/support.js and
// routes/disputes.js, both mounted above.

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
    const health = await getFeedHealthForTenant()
    // Engine counters ride along here so the feed and the engine consuming it
    // can be read together — `ready: false` with a healthy feed means the event
    // path is disabled or still building its index, and the interval fallbacks
    // are carrying the load.
    res.json({
      ...health,
      engine: {
        mode: String(process.env.ENGINE_MODE || 'interval').trim().toLowerCase(),
        event_path_armed: require('./services/priceBroadcast').isEngineEnabled(),
        ...require('./services/tradeEngine').getEngineStats()
      }
    })
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
  runReferralSeasonEngine,
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
    await ensureStartupInfrastructure()
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
