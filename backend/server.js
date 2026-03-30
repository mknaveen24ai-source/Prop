// NOTE: All date operations should use UTC methods (getUTC*, setUTC*)
// to ensure consistent behavior across timezones
require('dotenv').config()
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
const { securityHeaders, apiLimiter, abuseDetector, requestSizeLimiter } = require('./utils/security')
const logger = require('./utils/logger')

// -- Rate limiters --
const authLimiter = rateLimit({ windowMs: 1*60*1000, max: 10, message: { error: 'Too many attempts. Wait 1 minute.' }, standardHeaders: true, legacyHeaders: false })
const accountCreateLimiter = rateLimit({ windowMs: 60*60*1000, max: 20, message: { error: 'Too many account requests. Try again later.' }, standardHeaders: true, legacyHeaders: false })
const supportLimiter = rateLimit({ windowMs: 60*60*1000, max: 10, message: { error: 'Too many support requests. Wait before retrying.' }, standardHeaders: true, legacyHeaders: false })
const { fetchAndStorePrices, getCurrentPrices, subscribeSymbols, watchPriceFeed, pruneOldPriceHistory } = require('./priceFeed')

const authRoutes    = require('./routes/auth')
const accountRoutes = require('./routes/accounts')
const { router: tradeRoutes, checkSLTP, checkPendingOrders, checkFloatingDrawdown } = require('./routes/trades')
const adminRoutes   = require('./routes/admin')
const payoutRoutes  = require('./routes/payouts')
const kycRoutes     = require('./routes/kyc')
const chatRoutes    = require('./routes/chat')
// ── TRADE COPIER ──────────────────────────────────────────────────────────────
const copierRoutes  = require('./routes/copier-routes')
// ─────────────────────────────────────────────────────────────────────────────
const { authenticateToken: authTok, authenticateAdmin: authAdm } = require('./routes/middleware')
const { runChallengeEngine } = require('./challengeEngine')
const { validateEnv } = require('./env')
const newsService = require('./services/newsService')

validateEnv()

async function ensureUniqueIds() {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS trader_uid TEXT`)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS users_trader_uid_uq ON users(trader_uid)`)
    await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS account_uid TEXT`)
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS accounts_account_uid_uq ON accounts(account_uid)`)

    await pool.query(`CREATE TABLE IF NOT EXISTS bbook_pnl (
      date              DATE PRIMARY KEY,
      accounts_passed   INT NOT NULL DEFAULT 0,
      accounts_failed   INT NOT NULL DEFAULT 0,
      accounts_expired  INT NOT NULL DEFAULT 0,
      new_funded        INT NOT NULL DEFAULT 0
    )`)
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
        user_id      TEXT,
        ip_address   TEXT,
        logged_in_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

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
  } catch (err) {
    logger.warn('[startup] Failed to backfill unique IDs:', { error: err.message })
  }
}

ensureUniqueIds()

const app = express()
const httpServer = createServer(app)

// Apply security middleware first
app.use(securityHeaders)
app.use(abuseDetector)
app.use(requestSizeLimiter)
app.use(apiLimiter)

const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
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

io.use(function(socket, next) {
  try {
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
        if (d?.role === 'admin') adminDecoded = d
      } catch {}
    }

    if (!userDecoded && !adminDecoded) {
      return next(new Error('Unauthorized socket'))
    }

    if (userDecoded?.userId) {
      socket.data.userId = String(userDecoded.userId)
      socket.join(socket.data.userId)
    }
    if (adminDecoded) {
      socket.data.isAdmin = true
      socket.join('admin')
    }

    next()
  } catch (err) {
    next(err)
  }
})

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }))
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}))
app.use(express.json())
app.use(cookieParser())
app.disable('x-powered-by')
app.use(function(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()')
  next()
})

// ── Secure uploads: require admin JWT ─────────────────────────────────────────
const uploadsRoot = path.resolve(__dirname, 'uploads')

function getAdminTokenFromRequest(req) {
  const auth = req.headers['authorization']
  const cookieToken = req.cookies ? req.cookies.admin_token : null
  if (auth && auth.startsWith('Bearer ')) return auth.split(' ')[1]
  if (cookieToken) return cookieToken
  return null
}
function isValidAdminToken(token) {
  if (!token || !process.env.ADMIN_JWT_SECRET) return false
  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET)
    return decoded && decoded.role === 'admin'
  } catch {
    return false
  }
}

app.use('/uploads', function(req, res) {
  const token = getAdminTokenFromRequest(req)
  if (!isValidAdminToken(token)) {
    return res.status(401).json({ error: 'Admin token required' })
  }
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

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth',     authLimiter,          authRoutes)
app.use('/api/accounts', accountCreateLimiter, accountRoutes)
app.use('/api/trades',   tradeRoutes)
app.use('/api/admin',    adminRoutes)
app.use('/api/admin',    copierRoutes)   // ← TRADE COPIER ROUTES (admin-protected)
app.use('/api/payouts',  payoutRoutes)
app.use('/api/kyc',      kycRoutes)
app.use('/api/chat',     chatRoutes)
app.use('/api/disputes', require('./routes/disputes'))

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
    if (!subject || !message) {
      return res.status(400).json({ error: 'Subject and message are required' })
    }
    // FIX (BUG-M5): DDL removed from here — table is created at startup in ensureUniqueIds()
    await pool.query(
      `INSERT INTO support_tickets (user_id, email, name, category, subject, message)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user_id || null, email || null, name || null, category || 'other', subject, message]
    )
    res.status(201).json({ message: 'Support ticket submitted successfully' })
  } catch (error) {
    logger.error('Support ticket error:', { error: error.message })
    res.status(500).json({ error: 'Could not submit support ticket' })
  }
})

app.get('/api/admin/support-tickets', authAdm, async function(req, res) {
  try {
    // FIX (BUG-M5): DDL removed from here — table is created at startup in ensureUniqueIds()
    const result = await pool.query(`SELECT * FROM support_tickets ORDER BY created_at DESC`)
    res.json(result.rows)
  } catch (error) { res.status(500).json({ error: 'Could not fetch tickets' }) }
})

app.patch('/api/admin/support-tickets/:id', authAdm, async function(req, res) {
  try {
    const { status } = req.body
    if (!['open', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }
    const result = await pool.query(
      `UPDATE support_tickets SET status = $1 WHERE id = $2 RETURNING *`,
      [status, req.params.id]
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
}

app.post('/api/disputes/submit', authTok, async function(req, res) {
  try {
    await ensureDisputesTable()
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
        `SELECT id FROM accounts WHERE id = $1 AND user_id = $2`,
        [accountId, req.user.userId]
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
      `SELECT COUNT(*) FROM trades t JOIN accounts a ON t.account_id = a.id WHERE a.user_id = $1 AND t.status = 'closed'`,
      [req.user.userId]
    )
    if (parseInt(tradeCheck.rows[0].count) < 1) {
      return res.status(400).json({ error: 'You must have at least one completed trade before filing a dispute.' })
    }
    const result = await pool.query(
      `INSERT INTO disputes (user_id, account_id, reason, description)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.userId, accountId, reason, description.trim()]
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
    const result = await pool.query(
      `SELECT d.*, a.account_uid, a.account_type, a.account_size
       FROM disputes d
       LEFT JOIN accounts a ON d.account_id = a.id
       WHERE d.user_id = $1
       ORDER BY d.created_at DESC`,
      [req.user.userId]
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not load disputes.' })
  }
})

app.get('/api/disputes/all', authAdm, async function(req, res) {
  try {
    await ensureDisputesTable()
    const result = await pool.query(
      `SELECT d.*, u.email, u.full_name, u.trader_uid,
              a.account_uid, a.account_type, a.account_size, a.status as account_status
       FROM disputes d
       JOIN users u ON d.user_id = u.id
       LEFT JOIN accounts a ON d.account_id = a.id
       ORDER BY d.created_at DESC`
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not load disputes.' })
  }
})

app.patch('/api/disputes/:id', authAdm, async function(req, res) {
  try {
    await ensureDisputesTable()
    const { id } = req.params
    const { status, admin_response } = req.body
    const valid = ['open', 'under_review', 'resolved', 'rejected']
    if (!valid.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${valid.join(', ')}` })
    }
    const result = await pool.query(
      `UPDATE disputes SET status = $1, admin_response = $2, updated_at = NOW()
       WHERE id = $3 RETURNING *`,
      [status, admin_response || null, id]
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
    const prices = await getCurrentPrices()
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
    const prices = await getCurrentPrices()
    const status = {
      healthy: true,
      instruments: {},
      message: 'Price feed operational'
    }
    
    const now = Date.now()
    for (const [instrument, data] of Object.entries(prices)) {
      const ageMs = data.age_ms || (now - new Date(data.updated_at).getTime())
      status.instruments[instrument] = {
        age_seconds: Math.round(ageMs / 1000),
        healthy: ageMs < 5000
      }
      if (ageMs >= 5000) {
        status.healthy = false
      }
    }
    
    if (!status.healthy) {
      status.message = 'Price feed is delayed - some instruments may have stale prices'
    }
    
    res.json(status)
  } catch (error) {
    logger.error('Price status error:', { error: error.message })
    res.status(500).json({ error: 'Could not check price status', healthy: false })
  }
})

// ── Socket.io ─────────────────────────────────────────────────────────────────
io.on('connection', function(socket) {
  logger.http('Socket connected:', { socketId: socket.id, isAdmin: socket.data?.isAdmin ? '[admin]' : `[user:${socket.data?.userId}]` })
  
  socket.on('join_account', function(userId) {
    const requested = String(userId || '').trim()
    if (!requested) return

    if (socket.data?.isAdmin) {
      if (requested === 'admin' || /^\d+$/.test(requested)) {
        socket.join(requested)
      }
      return
    }

    if (socket.data?.userId && requested === socket.data.userId) {
      socket.join(requested)
      return
    }

    socket.emit('auth_error', { error: 'Unauthorized room join' })
  })

  // Chat-specific socket events
  socket.on('join_chat', function(conversationId) {
    if (!conversationId) return
    socket.join(`chat:${conversationId}`)
  })

  socket.on('leave_chat', function(conversationId) {
    if (!conversationId) return
    socket.leave(`chat:${conversationId}`)
  })

  socket.on('typing_start', function({ conversationId, isTyping }) {
    if (!conversationId) return
    const room = `chat:${conversationId}`
    if (socket.data?.isAdmin) {
      socket.to(room).emit('user_typing', {
        conversationId,
        isTyping,
        isAdmin: true
      })
    } else {
      socket.to(room).emit('user_typing', {
        conversationId,
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

// Use Winston HTTP logging middleware
app.use(logger.httpMiddleware)

// ── Price feed ────────────────────────────────────────────────────────────────
subscribeSymbols()
fetchAndStorePrices()

pruneOldPriceHistory()
setInterval(pruneOldPriceHistory, 24 * 60 * 60 * 1000)

// FIX (BUG-M6): Track last emitted prices to avoid broadcasting identical data
// every second. Only emit when at least one price has actually changed.
let lastEmittedPricesHash = ''

watchPriceFeed(function(prices) {
  lastWatcherEmitAt = Date.now()
  const hash = JSON.stringify(prices)
  if (hash !== lastEmittedPricesHash) {
    lastEmittedPricesHash = hash
    io.emit('price_update', prices)
  }
})

// Fallback polling - runs every 1 second to ensure prices stay fresh if watcher fails
setInterval(async function() {
  try {
    await fetchAndStorePrices()
    const prices = await getCurrentPrices()
    if (Object.keys(prices).length > 0) {
      const hash = JSON.stringify(prices)
      if (hash !== lastEmittedPricesHash) {
        lastEmittedPricesHash = hash
        io.emit('price_update', prices)
      }
    }
  } catch (error) {
    logger.error('Price fallback interval error:', { error: error.message })
  }
}, 1000)

// ── Trading engine intervals ──────────────────────────────────────────────────
setInterval(function() { checkSLTP(io) },             500)
setInterval(function() { checkPendingOrders(io) },    500)
setInterval(function() { checkFloatingDrawdown(io) }, 500)

// ── Challenge engine ──────────────────────────────────────────────────────────
runChallengeEngine(io)
setInterval(() => runChallengeEngine(io), 30000)

// ── News Protection ───────────────────────────────────────────────────────────
newsService.start()
let lastClosedNewsId = ''

async function checkNewsForceClose() {
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
    lastClosedNewsId = newsId

    const openTrades = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'`
    )
    if (openTrades.rows.length === 0) return

    logger.info(`[news_close] Active USD High Impact: ${activeNews.title} — force-closing ${openTrades.rows.length} trades`)

    const prices = await getCurrentPrices()
    const client = await pool.connect()

    for (const trade of openTrades.rows) {
      try {
        const priceData = prices[trade.instrument]
        if (!priceData) continue

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const CONTRACT    = { EURUSD: 100000, GBPUSD: 100000, XAUUSD: 100, XAGUSD: 5000 }
        const contractSize = CONTRACT[trade.instrument] || 100000
        const priceDiff   = trade.direction === 'buy'
          ? close_price - parseFloat(trade.open_price)
          : parseFloat(trade.open_price) - close_price
        const demo_pnl = parseFloat((priceDiff * parseFloat(trade.lot_size) * contractSize).toFixed(2))

        await client.query('BEGIN')
        const locked = await client.query(
          `SELECT id FROM trades WHERE id = $1 AND status = 'open' FOR UPDATE SKIP LOCKED`,
          [trade.id]
        )
        if (locked.rows.length === 0) { await client.query('ROLLBACK'); continue }

        await client.query(
          `UPDATE trades SET status = 'closed', close_price = $1, close_time = NOW(),
           demo_pnl = $2, close_reason = 'News Close' WHERE id = $3`,
          [close_price, demo_pnl, trade.id]
        )
        await client.query(
          `UPDATE accounts SET
             current_balance = current_balance + $1,
             peak_balance    = GREATEST(peak_balance, current_balance + $1)
           WHERE id = $2`,
          [demo_pnl, trade.account_id]
        )
        io.to(`user_${trade.user_id}`).emit('trade_closed', { id: trade.id, close_price, demo_pnl, reason: 'News Close' })
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        logger.error(`News force-close error for trade ${trade.id}:`, { error: err.message })
      }
    }
    client.release()
  } catch (err) {
    logger.error('News force close interval error:', { error: err.message })
  }
}
setInterval(checkNewsForceClose, 10000)

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

    // Only run on Friday between 21:55 and 22:05 UTC
    if (dayUTC !== 5 || hourUTC !== 21 || minuteUTC < 55) return
    if (hourUTC === 22 && minuteUTC > 5) return

    // FIX (BUG-M2): Dedup — only run once per Friday using date string key
    const todayKey = now.toISOString().slice(0, 10) // e.g. '2026-03-27'
    if (weekendCloseExecutedDate === todayKey) return
    weekendCloseExecutedDate = todayKey

    const openTrades = await pool.query(
      `SELECT t.*, a.user_id FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE t.status = 'open'`
    )
    if (openTrades.rows.length === 0) return

    logger.info(`[weekend_close] Friday 21:55–22:05 UTC — force-closing ${openTrades.rows.length} open trades`)

    const prices = await getCurrentPrices()

    for (const trade of openTrades.rows) {
      try {
        const priceData = prices[trade.instrument]
        if (!priceData) continue

        const close_price = trade.direction === 'buy'
          ? parseFloat(priceData.bid)
          : parseFloat(priceData.ask)

        const CONTRACT    = { EURUSD: 100000, GBPUSD: 100000, XAUUSD: 100, XAGUSD: 5000 }
        const contractSize = CONTRACT[trade.instrument] || 100000
        const priceDiff   = trade.direction === 'buy'
          ? close_price - parseFloat(trade.open_price)
          : parseFloat(trade.open_price) - close_price
        const demo_pnl = parseFloat((priceDiff * parseFloat(trade.lot_size) * contractSize).toFixed(2))

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
        logger.error(`[weekend_close] Error on trade ${trade.id}:`, { error: tradeErr.message })
      }
    }

    const uniqueUsers = [...new Set(openTrades.rows.map(t => t.user_id))]
    for (const userId of uniqueUsers) {
      io.to(String(userId)).emit('account_update', {
        event:   'weekend_close',
        message: '🔦 All open positions have been closed for the weekend. Markets reopen Sunday 22:00 UTC.'
      })
    }

    logger.info('[weekend_close] Completed:', { tradesClosed: openTrades.rows.length })
  } catch (error) {
    logger.error('[weekend_close] Error:', { error: error.message })
  }
}
setInterval(weekendForceClose, 60 * 1000)

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
httpServer.listen(PORT, function() {
  logger.info('Server started:', { port: PORT, env: process.env.NODE_ENV || 'development' })
})

module.exports = { app, io }
