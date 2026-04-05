const express = require('express')
const router = express.Router()
const pool = require('../db')
const { authenticateAdmin, authenticateAdminPre2FA } = require('./middleware')
const jwt = require('jsonwebtoken')
const bcrypt = require('bcrypt')
const rateLimit = require('express-rate-limit')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const qrcode = require('qrcode')
const logger = require('../utils/logger')
const totp   = require('../utils/totp')
const { sendKycApprovedEmail, sendKycRejectedEmail } = require('../mailer')
require('dotenv').config()


// FIX (BUG-C3): Added strict rate limiter to admin login. The user-facing login
// already had an authLimiter (10 req/min), but the admin login was completely
// unprotected, allowing unlimited brute-force password attempts.
const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,                    // 5 attempts total per IP
  message: { error: 'Too many admin login attempts. Please wait 15 minutes before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // don't count successful logins against the limit
})

const CONTRACT_SIZES = {
  EURUSD: 100000,
  GBPUSD: 100000,
  XAUUSD: 100,
  XAGUSD: 5000
}

let _featureTablesReady = false
async function ensureFeatureTables() {
  if (_featureTablesReady) return

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_incidents (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      status TEXT NOT NULL DEFAULT 'open',
      source TEXT,
      details TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      acknowledged_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      acknowledged_by TEXT
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_incidents_status_created ON admin_incidents(status, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_rules (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'global',
      condition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      action_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      priority INTEGER NOT NULL DEFAULT 100,
      trigger_count INTEGER NOT NULL DEFAULT 0,
      last_triggered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_rules_enabled_priority ON admin_rules(enabled, priority ASC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_enforcement_events (
      id BIGSERIAL PRIMARY KEY,
      rule_id BIGINT REFERENCES admin_rules(id) ON DELETE SET NULL,
      account_id TEXT,
      user_id TEXT,
      action TEXT NOT NULL,
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL DEFAULT 'applied',
      message TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_enforcement_events_created ON admin_enforcement_events(created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_immutable_audit (
      id BIGSERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      entity_type TEXT NOT NULL DEFAULT '',
      entity_id TEXT NOT NULL DEFAULT '',
      actor TEXT NOT NULL DEFAULT 'admin',
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      payload_text TEXT NOT NULL DEFAULT '{}',
      prev_hash TEXT NOT NULL,
      entry_hash TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_immutable_audit_created ON admin_immutable_audit(created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_four_eyes_requests (
      id BIGSERIAL PRIMARY KEY,
      action_type TEXT NOT NULL,
      target_type TEXT NOT NULL DEFAULT 'generic',
      target_id TEXT NOT NULL DEFAULT '',
      payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      requested_by TEXT NOT NULL DEFAULT 'admin',
      approvals_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      required_approvals INTEGER NOT NULL DEFAULT 2,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at TIMESTAMPTZ
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_four_eyes_status_created ON admin_four_eyes_requests(status, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_feature_flags (
      id BIGSERIAL PRIMARY KEY,
      flag_key TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      enabled BOOLEAN NOT NULL DEFAULT FALSE,
      rollout_pct INTEGER NOT NULL DEFAULT 100,
      segment TEXT NOT NULL DEFAULT 'all',
      updated_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_feature_flags_updated ON admin_feature_flags(updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_notifications (
      id BIGSERIAL PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'info',
      channel TEXT NOT NULL DEFAULT 'web',
      title TEXT NOT NULL DEFAULT '',
      message TEXT NOT NULL,
      audience TEXT NOT NULL DEFAULT 'all',
      status TEXT NOT NULL DEFAULT 'queued',
      scheduled_for TIMESTAMPTZ,
      sent_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_notifications_status_created ON admin_notifications(status, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_cases (
      id BIGSERIAL PRIMARY KEY,
      source_type TEXT NOT NULL DEFAULT 'manual',
      source_id TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'open',
      owner TEXT,
      notes TEXT,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_cases_status_priority ON admin_cases(status, priority, created_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_dispute_meta (
      id BIGSERIAL PRIMARY KEY,
      dispute_id TEXT NOT NULL UNIQUE,
      owner TEXT,
      priority TEXT NOT NULL DEFAULT 'normal',
      sla_hours INTEGER NOT NULL DEFAULT 48,
      notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_dispute_meta_updated ON admin_dispute_meta(updated_at DESC)`)

  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_scheduled_reports (
      id BIGSERIAL PRIMARY KEY,
      report_key TEXT NOT NULL,
      title TEXT NOT NULL,
      channel TEXT NOT NULL DEFAULT 'email',
      recipients TEXT NOT NULL DEFAULT '',
      schedule_cron TEXT NOT NULL DEFAULT '0 9 * * *',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      last_run_at TIMESTAMPTZ,
      next_run_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'admin',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_admin_scheduled_reports_enabled ON admin_scheduled_reports(enabled, updated_at DESC)`)

  // Backfill-safe columns used by auto-enforcement actions.
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flagged BOOLEAN NOT NULL DEFAULT FALSE`)
  await pool.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS review_flag_reason TEXT`)

  _featureTablesReady = true
}

async function getSettingsMap(keys) {
  if (!keys || keys.length === 0) return {}
  const result = await pool.query(
    `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
    [keys]
  )
  const out = {}
  for (const row of result.rows) out[row.key] = row.value
  return out
}

async function upsertSetting(client, key, value) {
  await client.query(
    `INSERT INTO platform_settings (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key)
     DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, String(value)]
  )
}

function toBool(v, fallback = false) {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  const s = String(v || '').toLowerCase().trim()
  if (['true', '1', 'yes', 'on'].includes(s)) return true
  if (['false', '0', 'no', 'off'].includes(s)) return false
  return fallback
}

function normalizeAuditPayload(payload) {
  try {
    return JSON.stringify(payload || {})
  } catch {
    return '{}'
  }
}

function buildAuditHash({ prevHash, eventType, entityType, entityId, payloadText, createdAt }) {
  const base = [
    String(prevHash || 'GENESIS'),
    String(eventType || ''),
    String(entityType || ''),
    String(entityId || ''),
    String(payloadText || '{}'),
    String(createdAt || '')
  ].join('|')
  return crypto.createHash('sha256').update(base).digest('hex')
}

async function appendImmutableAudit(db, { eventType, entityType = '', entityId = '', actor = 'admin', payload = {} }) {
  await ensureFeatureTables()
  const payloadText = normalizeAuditPayload(payload)
  const prevResult = await db.query(`SELECT entry_hash FROM admin_immutable_audit ORDER BY id DESC LIMIT 1`)
  const prevHash = prevResult.rows[0]?.entry_hash || 'GENESIS'
  const createdAt = new Date().toISOString()
  const entryHash = buildAuditHash({ prevHash, eventType, entityType, entityId, payloadText, createdAt })
  const ins = await db.query(
    `INSERT INTO admin_immutable_audit
      (event_type, entity_type, entity_id, actor, payload_json, payload_text, prev_hash, entry_hash, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::timestamptz)
     RETURNING *`,
    [
      String(eventType || 'event'),
      String(entityType || ''),
      String(entityId || ''),
      String(actor || 'admin'),
      payloadText,
      payloadText,
      prevHash,
      entryHash,
      createdAt
    ]
  )
  return ins.rows[0]
}

function calcTradePnl(direction, openPrice, currentPrice, lots, instrument) {
  const contractSize = CONTRACT_SIZES[instrument] || 100000
  const priceDiff = direction === 'buy'
    ? currentPrice - openPrice
    : openPrice - currentPrice
  return parseFloat((priceDiff * lots * contractSize).toFixed(2))
}

async function forceCloseOpenTradesForAccount(client, accountId) {
  const openTrades = await client.query(
    `SELECT t.id, t.instrument, t.direction, t.open_price, t.lot_size,
            p.bid, p.ask
       FROM trades t
       LEFT JOIN price_feed p ON p.instrument = t.instrument
      WHERE t.account_id = $1 AND t.status = 'open'
      FOR UPDATE`,
    [accountId]
  )

  if (openTrades.rows.length === 0) {
    return { closedCount: 0, totalPnl: 0 }
  }

  let totalPnl = 0
  for (const t of openTrades.rows) {
    const openPrice = parseFloat(t.open_price || 0)
    const lots = parseFloat(t.lot_size || 0)
    const fallbackPrice = openPrice
    const currentPrice = t.direction === 'buy'
      ? parseFloat(t.bid || fallbackPrice)
      : parseFloat(t.ask || fallbackPrice)
    const pnl = calcTradePnl(t.direction, openPrice, currentPrice, lots, t.instrument)
    totalPnl += pnl

    await client.query(
      `UPDATE trades
          SET status = 'closed',
              close_price = $1,
              close_time = NOW(),
              demo_pnl = $2,
              close_reason = 'Admin Auto Enforcement'
        WHERE id = $3`,
      [currentPrice, pnl, t.id]
    )
  }

  await client.query(
    `UPDATE accounts
        SET current_balance = current_balance + $1,
            peak_balance = GREATEST(peak_balance, current_balance + $1),
            updated_at = NOW()
      WHERE id = $2`,
    [totalPnl, accountId]
  )

  return { closedCount: openTrades.rows.length, totalPnl: parseFloat(totalPnl.toFixed(2)) }
}

async function getExposureData(pool) {
  const pricesResult = await pool.query('SELECT instrument, bid, ask FROM price_feed');
  const priceMap = {};
  pricesResult.rows.forEach(p => priceMap[p.instrument] = p);

  const exposureQ = await pool.query(`
    SELECT instrument, direction, lot_size, open_price 
    FROM trades WHERE status = 'open'
  `);

  const exposureGroups = {};
  let total_open_trades = 0;
  let total_floating_pnl = 0;

  for (const t of exposureQ.rows) {
    if (!exposureGroups[t.instrument]) {
      exposureGroups[t.instrument] = { buy_lots: 0, sell_lots: 0, trade_count: 0, floating_pnl: 0 };
    }
    const group = exposureGroups[t.instrument];
    const lot = parseFloat(t.lot_size);
    group.trade_count++;
    total_open_trades++;
    
    if (t.direction === 'buy') group.buy_lots += lot;
    else group.sell_lots += lot;
    
    const priceData = priceMap[t.instrument];
    if (priceData) {
      const currentPrice = t.direction === 'buy' ? parseFloat(priceData.bid) : parseFloat(priceData.ask);
      const contractSize = CONTRACT_SIZES[t.instrument] || 100000;
      const openPrice = parseFloat(t.open_price);
      const priceDiff = t.direction === 'buy' ? currentPrice - openPrice : openPrice - currentPrice;
      const pnl = priceDiff * lot * contractSize;
      group.floating_pnl += pnl;
      total_floating_pnl += pnl;
    }
  }

  const exposureData = Object.keys(exposureGroups).map(inst => {
    const g = exposureGroups[inst];
    const net = g.buy_lots - g.sell_lots;
    return {
      instrument: inst,
      buy_lots: g.buy_lots,
      long_lots: g.buy_lots,
      sell_lots: g.sell_lots,
      short_lots: g.sell_lots,
      net_lots: net,
      trade_count: g.trade_count,
      floating_pnl: g.floating_pnl,
      net_direction: net > 0 ? 'BUY' : net < 0 ? 'SELL' : 'FLAT',
      reverse_direction: net > 0 ? 'sell' : net < 0 ? 'buy' : 'flat',
      reverse_lots: Math.abs(net)
    };
  });

  return { exposureData, total_open_trades, total_floating_pnl };
}

// FIX (BUG-C3): adminLoginLimiter applied before the handler (defined above)
router.post('/login', adminLoginLimiter, async function(req, res) {
  try {
    const { password } = req.body
    const adminPassword = process.env.ADMIN_PASSWORD

    if (!adminPassword) {
      return res.status(500).json({ error: 'Admin password not configured' })
    }

    // FIX (CRITICAL #3): Enforce bcrypt hashing in production.
    // Plain-text admin passwords are a security risk. In production, we reject
    // plain-text passwords outright to prevent accidental misconfiguration.
    const isBcryptHash = adminPassword.startsWith('$2a$') || adminPassword.startsWith('$2b$') || adminPassword.startsWith('$2y$')

    if (process.env.NODE_ENV === 'production' && !isBcryptHash) {
      return res.status(500).json({
        error: 'Admin password must be a bcrypt hash in production. Run: node -e "require(\'bcrypt\').hash(\'YourPass\',12).then(console.log)"'
      })
    }

    // Use bcrypt for secure password hashing
    let isValidPassword = false
    if (isBcryptHash) {
      // Password is a proper bcrypt hash — compare correctly
      isValidPassword = await bcrypt.compare(String(password || ''), adminPassword)
    } else {
      // Development-only plain-text fallback (will be rejected in production)
      const crypto = require('crypto')
      isValidPassword = crypto.timingSafeEqual(
        Buffer.from(String(password || '')),
        Buffer.from(adminPassword)
      )
    }

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid admin password' })
    }

    // Read current admin token version so revoked sessions stay invalid.
    let adminTokenVersion = 1
    try {
      const tv = await pool.query(
        `SELECT value FROM platform_settings WHERE key = 'admin_token_version'`
      )
      if (tv.rows.length > 0) {
        const parsed = parseInt(tv.rows[0].value, 10)
        if (!Number.isNaN(parsed)) adminTokenVersion = parsed
      } else {
        await pool.query(
          `INSERT INTO platform_settings (key, value, updated_at)
           VALUES ('admin_token_version', '1', NOW())
           ON CONFLICT (key) DO NOTHING`
        )
      }
    } catch (_) {
      // Keep login functional even if token-version read fails.
    }

    // Check if admin 2FA is set up
    let admin2faEnabled = false
    let admin2faSecret  = null
    try {
      const s2fa = await pool.query(
        `SELECT value FROM platform_settings WHERE key = 'admin_totp_secret'`
      )
      if (s2fa.rows.length > 0 && s2fa.rows[0].value) {
        admin2faEnabled = true
        admin2faSecret  = s2fa.rows[0].value
      }
    } catch (_) {}

    if (admin2faEnabled) {
      // Step 1 of 2 — password OK, but issue a short-lived pre_2fa_admin token
      const pre2faToken = jwt.sign(
        { role: 'admin', type: 'pre_2fa_admin', atv: adminTokenVersion },
        process.env.ADMIN_JWT_SECRET,
        { expiresIn: '5m' }
      )
      return res.json({ requires2FA: true, pre2faToken })
    }

    // No 2FA configured — issue full admin token (unchanged original flow)
    const token = jwt.sign(
      { role: 'admin', atv: adminTokenVersion },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: '24h' }
    )

    // FIX (BUG-L5): Hardened admin cookie with sameSite: 'strict' (was 'lax').
    res.cookie('admin_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    })

    res.json({ message: 'Admin login successful', token })

  } catch (error) {
    res.status(500).json({ error: 'Admin login error' })
  }
})


router.post('/logout', function(req, res) {
  res.clearCookie('admin_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/'
  })
  res.json({ message: 'Admin logout successful' })
})

// ─────────────────────────────────────────────────────────────────────────────
// Admin 2FA routes
// ─────────────────────────────────────────────────────────────────────────────

const adminTwoFaValidateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many admin 2FA attempts. Please wait.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// POST /api/admin/2fa/setup — generate TOTP secret for admin, return QR + plain secret
router.post('/2fa/setup', authenticateAdmin, async function(req, res) {
  try {
    const label = `admin@${process.env.PLATFORM_NAME || 'PropFirm'}`
    const { base32, otpauthUrl } = totp.generateSecret(label)
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl)

    // Store encrypted temp secret in platform_settings
    const encTemp = totp.encryptSecret(base32)
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ('admin_totp_temp_secret', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [encTemp]
    )

    res.json({ qr: qrDataUrl, secret: base32 })
  } catch (err) {
    logger.error('[admin/2fa/setup] error:', { error: err.message })
    res.status(500).json({ error: 'Could not set up admin 2FA' })
  }
})

// POST /api/admin/2fa/verify-setup — confirm first code, activate admin 2FA
router.post('/2fa/verify-setup', authenticateAdmin, async function(req, res) {
  try {
    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    const tempRow = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'admin_totp_temp_secret'`
    )
    if (tempRow.rows.length === 0 || !tempRow.rows[0].value) {
      return res.status(400).json({ error: 'Run /api/admin/2fa/setup first' })
    }

    const plainTemp = totp.decryptSecret(tempRow.rows[0].value)
    const valid     = totp.verifyToken(plainTemp, token)
    if (!valid) return res.status(401).json({ error: 'Invalid code. Please try again.' })

    // Promote temp → live
    const encLive = totp.encryptSecret(plainTemp)
    await pool.query(
      `INSERT INTO platform_settings (key, value, updated_at)
       VALUES ('admin_totp_secret', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [encLive]
    )
    // Remove temp
    await pool.query(`DELETE FROM platform_settings WHERE key = 'admin_totp_temp_secret'`)

    logger.info('[admin/2fa] Admin 2FA enabled')
    res.json({ message: 'Admin 2FA enabled successfully. It will be required on next login.' })
  } catch (err) {
    logger.error('[admin/2fa/verify-setup] error:', { error: err.message })
    res.status(500).json({ error: 'Could not activate admin 2FA' })
  }
})

// POST /api/admin/2fa/validate — step 2 of admin login when 2FA is set up
router.post('/2fa/validate', adminTwoFaValidateLimiter, authenticateAdminPre2FA, async function(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'admin_ip'
  const rl = totp.checkRateLimit(`admin:${ip}`)
  if (rl.blocked) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${rl.remaining} minute(s).` })
  }

  try {
    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    const secretRow = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'admin_totp_secret'`
    )
    if (secretRow.rows.length === 0 || !secretRow.rows[0].value) {
      return res.status(400).json({ error: 'Admin 2FA is not configured' })
    }

    const plainSecret = totp.decryptSecret(secretRow.rows[0].value)
    const valid       = totp.verifyToken(plainSecret, token)

    if (!valid) {
      totp.recordFailure(`admin:${ip}`)
      return res.status(401).json({ error: 'Invalid code. Please try again.' })
    }

    totp.clearAttempts(`admin:${ip}`)

    const { atv } = req.adminPre2fa
    const fullToken = jwt.sign(
      { role: 'admin', atv: atv || 1 },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: '24h' }
    )

    res.cookie('admin_token', fullToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/'
    })

    res.json({ message: 'Admin login successful', token: fullToken })
  } catch (err) {
    logger.error('[admin/2fa/validate] error:', { error: err.message })
    res.status(500).json({ error: 'Could not verify admin 2FA token' })
  }
})

// POST /api/admin/2fa/disable — disable admin 2FA (requires admin auth + valid token)
router.post('/2fa/disable', authenticateAdmin, async function(req, res) {
  try {
    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    const secretRow = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'admin_totp_secret'`
    )
    if (secretRow.rows.length === 0 || !secretRow.rows[0].value) {
      return res.status(400).json({ error: 'Admin 2FA is not configured' })
    }

    const plainSecret = totp.decryptSecret(secretRow.rows[0].value)
    const valid       = totp.verifyToken(plainSecret, token)
    if (!valid) return res.status(401).json({ error: 'Invalid 2FA code' })

    await pool.query(`DELETE FROM platform_settings WHERE key = 'admin_totp_secret'`)
    await pool.query(`DELETE FROM platform_settings WHERE key = 'admin_totp_temp_secret'`)

    logger.info('[admin/2fa] Admin 2FA disabled')
    res.json({ message: 'Admin 2FA disabled' })
  } catch (err) {
    logger.error('[admin/2fa/disable] error:', { error: err.message })
    res.status(500).json({ error: 'Could not disable admin 2FA' })
  }
})

router.get('/overview', authenticateAdmin, async function(req, res) {

  try {
    const accounts = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'phase1') AS phase1_active,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'phase2') AS phase2_active,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'funded') AS funded_active,
        COUNT(*) FILTER (WHERE status = 'failed') AS total_failed,
        COUNT(*) FILTER (WHERE status = 'passed') AS total_passed,
        COUNT(*) FILTER (WHERE status = 'expired') AS total_expired
       FROM accounts`
    )

    const users = await pool.query(
      `SELECT
        COUNT(*) AS total_users,
        COUNT(*) FILTER (WHERE kyc_status = 'pending') AS kyc_pending,
        COUNT(*) FILTER (WHERE kyc_status = 'approved') AS kyc_approved
       FROM users`
    )

    const pnl = await pool.query(
      `SELECT
        COALESCE(SUM(demo_pnl), 0) AS total_demo_pnl,
        COALESCE(SUM(broker_pnl), 0) AS total_broker_pnl,
        COUNT(*) FILTER (WHERE status = 'closed') AS total_closed_trades,
        COUNT(*) FILTER (WHERE status = 'open') AS total_open_trades
       FROM trades`
    )

    const payouts = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending_payouts,
        COALESCE(SUM(amount_payable) FILTER (WHERE status = 'paid'), 0) AS total_paid_out
       FROM payouts`
    )

    const bannedUsers = await pool.query(`SELECT COUNT(*) as banned FROM users WHERE is_banned = true`);
    const flaggedPayouts = await pool.query(`SELECT COUNT(*) as flagged FROM payouts WHERE status = 'flagged'`);

    const { exposureData } = await getExposureData(pool);

    res.json({
      accounts: {
        phase1: parseInt(accounts.rows[0].phase1_active || 0),
        phase2: parseInt(accounts.rows[0].phase2_active || 0),
        funded: parseInt(accounts.rows[0].funded_active || 0),
        failed: parseInt(accounts.rows[0].total_failed || 0),
        passed: parseInt(accounts.rows[0].total_passed || 0),
        expired: parseInt(accounts.rows[0].total_expired || 0)
      },
      users: {
        total: parseInt(users.rows[0].total_users || 0),
        pending_kyc: parseInt(users.rows[0].kyc_pending || 0),
        approved_kyc: parseInt(users.rows[0].kyc_approved || 0),
        banned: parseInt(bannedUsers.rows[0].banned || 0)
      },
      trades: {
        open: parseInt(pnl.rows[0].total_open_trades || 0),
        total_pnl: parseFloat(pnl.rows[0].total_demo_pnl || 0)
      },
      payouts: {
        pending: parseInt(payouts.rows[0].pending_payouts || 0),
        total_paid: parseFloat(payouts.rows[0].total_paid_out || 0),
        flagged_count: parseInt(flaggedPayouts.rows[0].flagged || 0)
      },
      exposure: exposureData,
      settings: {}
    })

  } catch (error) {
    logger.error('Admin overview error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch overview' })
  }
})

router.get('/traders', authenticateAdmin, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, country, phone, kyc_status,
        is_banned, affiliate_code, created_at
       FROM users ORDER BY created_at DESC`
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch traders' })
  }
})

router.post('/kyc/approve', authenticateAdmin, async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = parseInt(req.body.user_id, 10)
    if (!Number.isFinite(user_id) || user_id <= 0) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users SET kyc_status = 'approved' WHERE id = $1 RETURNING id, email, full_name`,
      [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'kyc_approved',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (_) {}

    // Send automated email to the user
    await sendKycApprovedEmail(result.rows[0].email, result.rows[0].full_name)

    res.json({ message: 'KYC approved successfully' })
  } catch (error) {
    logger.error('KYC approve error:', { error: error.message })
    res.status(500).json({ error: 'Could not approve KYC' })
  }
})

router.post('/kyc/reject', authenticateAdmin, async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = parseInt(req.body.user_id, 10)
    const { reason } = req.body
    if (!Number.isFinite(user_id) || user_id <= 0) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users SET kyc_status = 'rejected'
       ${ reason ? `, kyc_rejection_reason = $2` : '' }
       WHERE id = $1 RETURNING id, email, full_name`,
      reason ? [user_id, String(reason).slice(0, 500)] : [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'kyc_rejected',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email, reason: reason || '' }
      })
    } catch (_) {}

    // Send automated email to the user
    await sendKycRejectedEmail(result.rows[0].email, result.rows[0].full_name, reason)

    res.json({ message: 'KYC rejected' })
  } catch (error) {
    logger.error('KYC reject error:', { error: error.message })
    res.status(500).json({ error: 'Could not reject KYC' })
  }
})

router.post('/ban', authenticateAdmin, async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = parseInt(req.body.user_id, 10)
    if (!Number.isFinite(user_id) || user_id <= 0) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users SET is_banned = true WHERE id = $1 RETURNING id, email`,
      [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'user_banned',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (_) {}

    res.json({ message: 'Trader banned successfully' })
  } catch (error) {
    logger.error('Ban trader error:', { error: error.message })
    res.status(500).json({ error: 'Could not ban trader' })
  }
})

router.post('/unban', authenticateAdmin, async function(req, res) {
  try {
    // FIX (BUG-H1): Added user_id validation and immutable audit log
    const user_id = parseInt(req.body.user_id, 10)
    if (!Number.isFinite(user_id) || user_id <= 0) {
      return res.status(400).json({ error: 'Valid user_id is required' })
    }

    const result = await pool.query(
      `UPDATE users SET is_banned = false WHERE id = $1 RETURNING id, email`,
      [user_id]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'user_unbanned',
        entityType: 'user',
        entityId: String(user_id),
        payload: { email: result.rows[0].email }
      })
    } catch (_) {}

    res.json({ message: 'Trader unbanned successfully' })
  } catch (error) {
    logger.error('Unban trader error:', { error: error.message })
    res.status(500).json({ error: 'Could not unban trader' })
  }
})

router.get('/accounts', authenticateAdmin, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT a.id, a.user_id, a.account_type, a.account_size, a.current_balance,
              a.starting_balance, a.peak_balance, a.status, a.profit_target,
              a.max_drawdown_pct, a.created_at, a.updated_at, a.account_uid,
              u.email, u.full_name
       FROM accounts a
       JOIN users u ON a.user_id = u.id
       ORDER BY a.created_at DESC`
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch accounts' })
  }
})

router.get('/payouts', authenticateAdmin, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT p.id, p.user_id, p.account_id, p.amount_requested, p.amount_payable,
              p.payment_method, p.payment_details, p.status, p.is_flagged,
              p.flag_reason, p.requested_at, p.paid_at, p.transaction_id,
              u.email, u.full_name
       FROM payouts p
       JOIN users u ON p.user_id = u.id
       ORDER BY p.requested_at DESC`
    )
    res.json(result.rows)
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch payouts' })
  }
})

router.post('/payouts/approve', authenticateAdmin, async function(req, res) {
  try {
    const { payout_id, transaction_id } = req.body

    // Fetch payout details and user email/name first
    const payoutData = await pool.query(
      `SELECT p.amount_payable, p.payment_method, u.email, u.full_name 
       FROM payouts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1`,
      [payout_id]
    )

    if (payoutData.rows.length === 0) {
      return res.status(404).json({ error: 'Payout not found' })
    }

    const { amount_payable, payment_method, email, full_name } = payoutData.rows[0]

    await pool.query(
      `UPDATE payouts SET
       status = 'paid',
       paid_at = NOW(),
       transaction_id = $1
       WHERE id = $2`,
      [transaction_id, payout_id]
    )

    // Send automated email to the user
    await sendPayoutApprovedEmail(email, full_name, amount_payable, payment_method)

    res.json({ message: 'Payout marked as paid and user notified' })
  } catch (error) {
    logger.error('Could not mark payout as paid:', { error: error.message })
    res.status(500).json({ error: 'Could not update payout' })
  }
})

router.post('/payouts/reject', authenticateAdmin, async function(req, res) {
  try {
    const { payout_id, reason } = req.body

    if (!payout_id) return res.status(400).json({ error: 'payout_id is required' })

    // Fetch payout details and user email/name
    const payoutData = await pool.query(
      `SELECT p.amount_requested, u.email, u.full_name 
       FROM payouts p
       JOIN users u ON p.user_id = u.id
       WHERE p.id = $1`,
      [payout_id]
    )

    if (payoutData.rows.length === 0) {
      return res.status(404).json({ error: 'Payout not found' })
    }

    const { amount_requested, email, full_name } = payoutData.rows[0]

    await pool.query(
      `UPDATE payouts SET
       status = 'rejected',
       updated_at = NOW(),
       admin_notes = $1
       WHERE id = $2`,
      [reason || 'Rejected by admin', payout_id]
    )

    // Send automated email to the user
    await sendPayoutRejectedEmail(email, full_name, amount_requested, reason)

    res.json({ message: 'Payout rejected and user notified' })
  } catch (error) {
    logger.error('Could not reject payout:', { error: error.message })
    res.status(500).json({ error: 'Could not update payout' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

router.get('/risk-scores', authenticateAdmin, async (req, res) => {
  try {
    // FIX (BUG-H2): Replaced RANDOM() with real calculations:
    //   - win_rate_pct: actual wins / closed trades
    //   - avg_hold_seconds: real avg from open_time/close_time
    //   - total_trades: real count, flagged_payouts: real count
    const result = await pool.query(`
      SELECT
        u.id AS user_id,
        u.full_name,
        u.email,
        a.id AS account_id,
        a.account_type,
        a.status AS account_status,
        a.review_flagged,
        COUNT(t.id) FILTER (WHERE t.status = 'closed')                             AS total_trades,
        COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)          AS winning_trades,
        CASE
          WHEN COUNT(t.id) FILTER (WHERE t.status = 'closed') = 0 THEN 0
          ELSE ROUND(
            COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::numeric
            / COUNT(t.id) FILTER (WHERE t.status = 'closed') * 100, 1
          )
        END AS win_rate_pct,
        COALESCE(ROUND(
          AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)))
          FILTER (WHERE t.status = 'closed' AND t.open_time IS NOT NULL AND t.close_time IS NOT NULL)
        , 0), 0) AS avg_hold_seconds,
        COUNT(p.id) FILTER (WHERE p.is_flagged = true)                              AS flagged_payouts,
        COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0)             AS total_pnl,
        -- Computed risk_score 0-100: higher score = more suspicious trader
        LEAST(100, (
          20
          + CASE
              WHEN COUNT(t.id) FILTER (WHERE t.status = 'closed') > 0
               AND ROUND(
                    COUNT(t.id) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::numeric
                    / COUNT(t.id) FILTER (WHERE t.status = 'closed') * 100, 1
                  ) > 70
              THEN 40 ELSE 0
            END
          + CASE
              WHEN COALESCE(ROUND(
                  AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)))
                  FILTER (WHERE t.status = 'closed' AND t.open_time IS NOT NULL AND t.close_time IS NOT NULL)
              , 0), 9999) < 300
               AND COUNT(t.id) FILTER (WHERE t.status = 'closed') > 0
              THEN 20 ELSE 0
            END
          + CASE WHEN COUNT(p.id) FILTER (WHERE p.is_flagged = true) > 0 THEN 20 ELSE 0 END
          + CASE WHEN a.review_flagged THEN 20 ELSE 0 END
        )) AS risk_score
      FROM users u
      JOIN accounts a ON a.user_id = u.id
      LEFT JOIN trades t ON t.account_id = a.id
      LEFT JOIN payouts p ON p.user_id = u.id
      WHERE a.status IN ('active', 'funded')
      GROUP BY u.id, u.full_name, u.email, a.id, a.account_type, a.status, a.review_flagged
      ORDER BY risk_score DESC, total_trades DESC
      LIMIT 200
    `);
    res.json(result.rows);
  } catch (err) {
    logger.error('Risk scores error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load risk scores' });
  }
});

router.get('/account-health', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        a.id::text AS account_id,
        COALESCE(a.account_uid::text, a.id::text) AS account_uid,
        a.account_type,
        a.status AS account_status,
        COALESCE(a.account_size, 0)::numeric AS account_size,
        COALESCE(a.current_balance, 0)::numeric AS current_balance,
        COALESCE(a.peak_balance, 0)::numeric AS peak_balance,
        COALESCE(a.review_flagged, false) AS review_flagged,
        a.created_at,
        u.id::text AS user_id,
        u.full_name,
        u.email,
        COALESCE(u.kyc_status, 'pending') AS kyc_status,
        COALESCE(u.is_banned, false) AS is_banned,
        COALESCE(ts.closed_trades, 0)::int AS closed_trades,
        COALESCE(ts.winning_trades, 0)::int AS winning_trades,
        COALESCE(ts.win_rate_pct, 0)::numeric AS win_rate_pct,
        COALESCE(ts.avg_hold_seconds, 0)::numeric AS avg_hold_seconds,
        COALESCE(ts.total_pnl, 0)::numeric AS total_pnl,
        COALESCE(ps.flagged_payouts, 0)::int AS flagged_payouts,
        COALESCE(ds.open_disputes, 0)::int AS open_disputes
      FROM accounts a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN (
        SELECT
          t.account_id,
          COUNT(*) FILTER (WHERE t.status = 'closed')::int AS closed_trades,
          COUNT(*) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::int AS winning_trades,
          CASE
            WHEN COUNT(*) FILTER (WHERE t.status = 'closed') = 0 THEN 0
            ELSE ROUND(
              (COUNT(*) FILTER (WHERE t.status = 'closed' AND t.demo_pnl > 0)::numeric)
              / NULLIF(COUNT(*) FILTER (WHERE t.status = 'closed'), 0) * 100, 2
            )
          END AS win_rate_pct,
          COALESCE(ROUND(
            AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time)))
            FILTER (WHERE t.status = 'closed' AND t.open_time IS NOT NULL AND t.close_time IS NOT NULL), 0
          ), 0) AS avg_hold_seconds,
          COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.status = 'closed'), 0) AS total_pnl
        FROM trades t
        GROUP BY t.account_id
      ) ts ON ts.account_id = a.id
      LEFT JOIN (
        SELECT p.account_id, COUNT(*) FILTER (WHERE p.is_flagged = true)::int AS flagged_payouts
        FROM payouts p
        GROUP BY p.account_id
      ) ps ON ps.account_id = a.id
      LEFT JOIN (
        SELECT d.account_id::text AS account_id, COUNT(*) FILTER (WHERE d.status IN ('open', 'under_review'))::int AS open_disputes
        FROM disputes d
        GROUP BY d.account_id::text
      ) ds ON ds.account_id = a.id::text
      WHERE a.status IN ('active', 'funded', 'locked')
      ORDER BY a.created_at DESC
      LIMIT 500
    `)

    const rows = result.rows.map(r => {
      const accountSize = parseFloat(r.account_size || 0)
      const currentBalance = parseFloat(r.current_balance || 0)
      const totalPnl = parseFloat(r.total_pnl || 0)
      const closedTrades = parseInt(r.closed_trades || 0, 10)
      const winRate = parseFloat(r.win_rate_pct || 0)
      const avgHoldSec = parseFloat(r.avg_hold_seconds || 0)
      const flaggedPayouts = parseInt(r.flagged_payouts || 0, 10)
      const openDisputes = parseInt(r.open_disputes || 0, 10)
      const accountAgeDays = r.created_at
        ? Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000))
        : 0

      let penalties = 0
      const reasons = []
      if (r.is_banned) { penalties += 70; reasons.push('User is banned') }
      if (r.account_status === 'locked') { penalties += 40; reasons.push('Account is locked') }
      if (r.review_flagged) { penalties += 25; reasons.push('Account flagged for manual review') }
      if (String(r.kyc_status) !== 'approved') { penalties += 15; reasons.push('KYC not approved') }
      if (flaggedPayouts > 0) { penalties += Math.min(30, flaggedPayouts * 10); reasons.push(`Flagged payouts: ${flaggedPayouts}`) }
      if (openDisputes > 0) { penalties += Math.min(25, openDisputes * 8); reasons.push(`Open disputes: ${openDisputes}`) }
      if (closedTrades >= 20 && winRate >= 75 && avgHoldSec > 0 && avgHoldSec < 180) {
        penalties += 15
        reasons.push('Unusually high win rate with very short holds')
      }
      if (accountSize > 0 && totalPnl <= -(accountSize * 0.12)) {
        penalties += 12
        reasons.push('Deep realized loss vs account size')
      }
      if (accountAgeDays <= 7 && closedTrades >= 40) {
        penalties += 10
        reasons.push('High activity on very new account')
      }

      const healthScore = Math.max(0, Math.min(100, 100 - penalties))
      const healthBand = healthScore >= 75 ? 'healthy' : healthScore >= 45 ? 'watch' : 'critical'
      return {
        ...r,
        account_size: accountSize,
        current_balance: currentBalance,
        total_pnl: parseFloat(totalPnl.toFixed(2)),
        closed_trades: closedTrades,
        win_rate_pct: parseFloat(winRate.toFixed(2)),
        avg_hold_seconds: parseFloat(avgHoldSec.toFixed(0)),
        flagged_payouts: flaggedPayouts,
        open_disputes: openDisputes,
        account_age_days: accountAgeDays,
        health_score: healthScore,
        health_band: healthBand,
        reasons
      }
    })

    const summary = {
      total: rows.length,
      healthy: rows.filter(r => r.health_band === 'healthy').length,
      watch: rows.filter(r => r.health_band === 'watch').length,
      critical: rows.filter(r => r.health_band === 'critical').length,
      avg_health_score: rows.length > 0
        ? parseFloat((rows.reduce((sum, r) => sum + r.health_score, 0) / rows.length).toFixed(2))
        : 0
    }

    rows.sort((a, b) => a.health_score - b.health_score)
    res.json({ generated_at: new Date(), summary, rows })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load account health scores' })
  }
})

router.get('/suspicious-accounts', authenticateAdmin, async (req, res) => {
  try {
    // FIX (BUG-H3): Wired to real DB query — returns genuinely flagged/banned accounts
    const result = await pool.query(`
      SELECT
        a.id, a.user_id, a.account_type, a.account_size, a.status,
        a.review_flagged, a.review_flag_reason, a.created_at,
        u.email, u.full_name, u.is_banned
      FROM accounts a
      JOIN users u ON a.user_id = u.id
      WHERE a.review_flagged = true OR u.is_banned = true
      ORDER BY a.created_at DESC
      LIMIT 500
    `);
    res.json({
      total_flags: result.rows.filter(r => r.review_flagged).length,
      flagged: result.rows
    });
  } catch (err) {
    logger.error('Suspicious accounts error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load suspicious accounts' });
  }
});

router.get('/audit-log', authenticateAdmin, async (req, res) => {
  try {
    // FIX (BUG-H3): Wired to real immutable audit table
    await ensureFeatureTables()
    const limit  = Math.min(parseInt(req.query.limit  || '200', 10), 1000)
    const offset = parseInt(req.query.offset || '0', 10)
    const result = await pool.query(
      `SELECT id, event_type, entity_type, entity_id, actor, payload_json,
              prev_hash, entry_hash, created_at
       FROM admin_immutable_audit
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ entries: result.rows });
  } catch (err) {
    logger.error('Audit log error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load audit log' });
  }
});

router.get('/settings-log', authenticateAdmin, async (req, res) => {
  try {
    // FIX (BUG-H3): Wired to real immutable audit table filtered by settings events
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT id, event_type, entity_type, entity_id, actor, payload_json, created_at
       FROM admin_immutable_audit
       WHERE event_type = 'settings_updated'
       ORDER BY created_at DESC
       LIMIT 500`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('Settings log error:', { error: err.message });
    res.status(500).json({ error: 'Failed to load settings log' });
  }
});

router.get('/platform-analytics', authenticateAdmin, async (req, res) => {
  try {
    // FIX (BUG-L1): Replaced wrong "estimation" calculations. The old code used
    // phase2 total as "phase1_passed" and funded total as "phase2_passed" — both wrong.
    // Now uses explicit status='passed' + account_type filter for accurate pass counts.
    const r = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE account_type = 'phase1')                         AS p1t,
        COUNT(*) FILTER (WHERE account_type = 'phase2')                         AS p2t,
        COUNT(*) FILTER (WHERE account_type = 'funded')                         AS ft,
        COUNT(*) FILTER (WHERE status = 'active' AND account_type = 'funded')   AS fa,
        COUNT(*) FILTER (WHERE status = 'passed' AND account_type = 'phase1')   AS p1_passed,
        COUNT(*) FILTER (WHERE status = 'passed' AND account_type = 'phase2')   AS p2_passed
      FROM accounts
    `);
    res.json({
      funnel: {
        phase1_total:  parseInt(r.rows[0].p1t || 0),
        phase1_passed: parseInt(r.rows[0].p1_passed || 0),
        phase2_total:  parseInt(r.rows[0].p2t || 0),
        phase2_passed: parseInt(r.rows[0].p2_passed || 0),
        funded_total:  parseInt(r.rows[0].ft || 0),
        funded_active: parseInt(r.rows[0].fa || 0)
      }
    });
  } catch (err) {
    logger.error('Platform analytics error:', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/bbook-report', authenticateAdmin, async (req, res) => {
  try {
    const q1 = await pool.query(`SELECT COALESCE(SUM(amount_payable), 0) as paid FROM payouts WHERE status = 'paid'`);
    const q2 = await pool.query(`
      SELECT
        COUNT(*) FILTER(WHERE status='failed') as fails,
        COUNT(*) FILTER(WHERE status='active' AND account_type='funded') as active
      FROM accounts
    `);
    // FIX (BUG-L8): Replaced hardcoded 0 values with real PnL sums from trades table
    const q3 = await pool.query(`
      SELECT
        COALESCE(SUM(demo_pnl) FILTER (WHERE demo_pnl > 0 AND status = 'closed'), 0) AS gross_profit,
        ABS(COALESCE(SUM(demo_pnl) FILTER (WHERE demo_pnl < 0 AND status = 'closed'), 0)) AS gross_loss
      FROM trades
    `);

    const grossProfit = parseFloat(q3.rows[0].gross_profit || 0);
    const grossLoss   = parseFloat(q3.rows[0].gross_loss || 0);
    const totalPaidOut = parseFloat(q1.rows[0].paid || 0);

    res.json({
      totals: {
        total_trader_profits:  parseFloat(grossProfit.toFixed(2)),
        total_trader_losses:   parseFloat(grossLoss.toFixed(2)),
        total_paid_out:        parseFloat(totalPaidOut.toFixed(2)),
        net_firm_pnl:          parseFloat((grossLoss - grossProfit - totalPaidOut).toFixed(2)),
        total_failed:          parseInt(q2.rows[0].fails || 0),
        total_funded_active:   parseInt(q2.rows[0].active || 0)
      }
    });
  } catch (err) {
    logger.error('Bbook report error:', { error: err.message });
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/settings', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM platform_settings');
    const settings = {};
    result.rows.forEach(r => settings[r.key] = r.value);
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load settings' });
  }
});

router.post('/settings', authenticateAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const keys = Object.keys(req.body);
    for (const key of keys) {
      await client.query(
        `INSERT INTO platform_settings (key, value, updated_at) 
         VALUES ($1, $2, NOW()) 
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, String(req.body[key])]
      );
    }
    try {
      await appendImmutableAudit(client, {
        eventType: 'settings_updated',
        entityType: 'platform_settings',
        entityId: 'global',
        payload: { keys }
      })
    } catch (_) {}
    await client.query('COMMIT');
    res.json({ message: 'Settings saved successfully' });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Failed to save settings' });
  } finally {
    client.release();
  }
});

router.get('/price-feed-health', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query('SELECT instrument, bid, ask, updated_at FROM price_feed');
    // FIX (BUG-L9): ticks_last_5min was hardcoded as 124. Now queries real count
    // from price_feed_history for each instrument over the last 5 minutes.
    const tickCounts = await pool.query(`
      SELECT instrument, COUNT(*) AS tick_count
      FROM price_feed_history
      WHERE recorded_at > NOW() - INTERVAL '5 minutes'
      GROUP BY instrument
    `);
    const tickMap = {};
    tickCounts.rows.forEach(r => { tickMap[r.instrument] = parseInt(r.tick_count || 0); });

    const mapped = result.rows.map(r => ({
      updated_at: r.updated_at || null,
      instrument: r.instrument,
      bid: r.bid,
      ask: r.ask,
      seconds_since_update: r.updated_at
        ? Math.max(0, Math.floor((Date.now() - new Date(r.updated_at).getTime()) / 1000))
        : null,
      ticks_last_5min: tickMap[r.instrument] || 0,
      status: r.updated_at
        ? (Date.now() - new Date(r.updated_at).getTime() < 30000 ? 'operational' : 'stale')
        : 'unknown'
    }));
    res.json({ instruments: mapped });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/risk-dashboard', authenticateAdmin, async (req, res) => {
  try {
    const { exposureData, total_open_trades, total_floating_pnl } = await getExposureData(pool);

    res.json({
      exposure: exposureData,
      total_open_trades: total_open_trades,
      total_floating_pnl: total_floating_pnl,
      near_breach_accounts: [],
      near_target_accounts: [],
      updated_at: new Date()
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed' });
  }
});

router.get('/price-staleness', authenticateAdmin, async (req, res) => {
  res.json({ any_stale: false, stale_instruments: [] });
});

// ---------------------------------------------------------------------------
// FEATURE MODULES (MVP): Incident Center, Rule Builder, Auto Enforcement,
// Payout Fraud Scoring, Device/IP Link Graph
// ---------------------------------------------------------------------------

router.get('/incidents', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT id, title, severity, status, source, details, created_at, updated_at,
              acknowledged_at, resolved_at, acknowledged_by
       FROM admin_incidents ORDER BY created_at DESC LIMIT 300`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load incidents' })
  }
})

router.post('/incidents', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const { title, severity = 'medium', source = 'manual', details = '' } = req.body || {}
    if (!title || String(title).trim().length < 3) {
      return res.status(400).json({ error: 'Title is required (min 3 chars)' })
    }
    const allowedSeverity = new Set(['low', 'medium', 'high', 'critical'])
    const sev = allowedSeverity.has(String(severity)) ? String(severity) : 'medium'

    const result = await pool.query(
      `INSERT INTO admin_incidents (title, severity, status, source, details, updated_at)
       VALUES ($1, $2, 'open', $3, $4, NOW())
       RETURNING *`,
      [String(title).trim(), sev, String(source || 'manual').trim(), String(details || '').trim()]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'incident_created',
        entityType: 'incident',
        entityId: String(result.rows[0].id),
        payload: {
          severity: sev,
          source: String(source || 'manual').trim()
        }
      })
    } catch (_) {}
    res.status(201).json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create incident' })
  }
})

router.post('/incidents/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const { status } = req.body || {}
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid incident id' })

    const allowed = new Set(['open', 'acknowledged', 'resolved'])
    if (!allowed.has(String(status))) return res.status(400).json({ error: 'Invalid status' })

    const isAck = status === 'acknowledged'
    const isResolved = status === 'resolved'
    const r = await pool.query(
      `UPDATE admin_incidents
          SET status = $1,
              updated_at = NOW(),
              acknowledged_at = CASE WHEN $2 THEN COALESCE(acknowledged_at, NOW()) ELSE acknowledged_at END,
              resolved_at = CASE WHEN $3 THEN NOW() ELSE NULL END,
              acknowledged_by = CASE WHEN $2 THEN 'admin' ELSE acknowledged_by END
        WHERE id = $4
        RETURNING *`,
      [status, isAck, isResolved, id]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Incident not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'incident_status_changed',
        entityType: 'incident',
        entityId: String(id),
        payload: { status: String(status) }
      })
    } catch (_) {}
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update incident status' })
  }
})

router.get('/rules', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const r = await pool.query(
      `SELECT id, name, scope, condition_json, action_json, enabled, priority,
              trigger_count, last_triggered_at, created_at, updated_at
       FROM admin_rules ORDER BY enabled DESC, priority ASC, created_at DESC LIMIT 500`
    )
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load rules' })
  }
})

router.post('/rules', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      name,
      scope = 'global',
      condition_json = {},
      action_json = {},
      enabled = true,
      priority = 100
    } = req.body || {}

    if (!name || String(name).trim().length < 3) {
      return res.status(400).json({ error: 'Rule name is required (min 3 chars)' })
    }

    const r = await pool.query(
      `INSERT INTO admin_rules (name, scope, condition_json, action_json, enabled, priority, updated_at)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, NOW())
       RETURNING *`,
      [
        String(name).trim(),
        String(scope || 'global').trim(),
        JSON.stringify(condition_json || {}),
        JSON.stringify(action_json || {}),
        !!enabled,
        Number.isFinite(parseInt(priority, 10)) ? parseInt(priority, 10) : 100
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'rule_created',
        entityType: 'rule',
        entityId: String(r.rows[0].id),
        payload: {
          name: String(name).trim(),
          scope: String(scope || 'global').trim()
        }
      })
    } catch (_) {}
    res.status(201).json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create rule' })
  }
})

router.post('/rules/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid rule id' })
    const r = await pool.query(
      `UPDATE admin_rules
          SET enabled = NOT enabled,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'Rule not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'rule_toggled',
        entityType: 'rule',
        entityId: String(id),
        payload: { enabled: !!r.rows[0].enabled }
      })
    } catch (_) {}
    res.json(r.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle rule' })
  }
})

router.delete('/rules/:id', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid rule id' })
    const r = await pool.query(`DELETE FROM admin_rules WHERE id = $1 RETURNING id`, [id])
    if (r.rows.length === 0) return res.status(404).json({ error: 'Rule not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'rule_deleted',
        entityType: 'rule',
        entityId: String(id),
        payload: {}
      })
    } catch (_) {}
    res.json({ message: 'Rule deleted' })
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete rule' })
  }
})

router.post('/rules/reorder', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const orderedIdsRaw = Array.isArray(req.body?.ordered_ids) ? req.body.ordered_ids : []
    const orderedIds = [...new Set(
      orderedIdsRaw
        .map(v => parseInt(v, 10))
        .filter(v => Number.isFinite(v))
    )]

    if (orderedIds.length === 0) {
      return res.status(400).json({ error: 'ordered_ids must be a non-empty array of rule ids' })
    }

    await client.query('BEGIN')
    await client.query(
      `UPDATE admin_rules r
          SET priority = src.ord * 10,
              updated_at = NOW()
         FROM (
           SELECT id::bigint AS id, ord::int AS ord
           FROM unnest($1::bigint[]) WITH ORDINALITY AS t(id, ord)
         ) src
        WHERE r.id = src.id`,
      [orderedIds]
    )
    const result = await client.query(
      `SELECT id, name, scope, condition_json, action_json, enabled, priority,
              trigger_count, last_triggered_at, created_at, updated_at
       FROM admin_rules ORDER BY enabled DESC, priority ASC, created_at DESC LIMIT 500`
    )

    try {
      await appendImmutableAudit(client, {
        eventType: 'rules_reordered',
        entityType: 'rule',
        entityId: 'bulk',
        payload: { ordered_ids: orderedIds.slice(0, 200) }
      })
    } catch (_) {}

    await client.query('COMMIT')
    res.json(result.rows)
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to reorder rules' })
  } finally {
    client.release()
  }
})

router.get('/enforcement/events', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const r = await pool.query(
      `SELECT id, rule_id, account_id, user_id, action, payload_json, status,
              message, created_at
       FROM admin_enforcement_events ORDER BY created_at DESC LIMIT 300`
    )
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load enforcement events' })
  }
})

router.post('/enforcement/apply', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const { account_id, action, reason = '', rule_id = null, payload = {} } = req.body || {}
    if (!account_id) return res.status(400).json({ error: 'account_id is required' })
    if (!action) return res.status(400).json({ error: 'action is required' })

    await client.query('BEGIN')

    const accResult = await client.query(
      `SELECT id, user_id, status FROM accounts WHERE id = $1 FOR UPDATE`,
      [String(account_id)]
    )
    if (accResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Account not found' })
    }

    const acc = accResult.rows[0]
    let message = ''
    let eventStatus = 'applied'

    if (action === 'lock_account') {
      await client.query(`UPDATE accounts SET status = 'locked', updated_at = NOW() WHERE id = $1`, [acc.id])
      message = 'Account locked'
    } else if (action === 'force_close_open_trades') {
      const closeResult = await forceCloseOpenTradesForAccount(client, acc.id)
      message = `Force-closed ${closeResult.closedCount} open trades; total P&L ${closeResult.totalPnl >= 0 ? '+' : ''}$${closeResult.totalPnl.toFixed(2)}`
    } else if (action === 'flag_for_review') {
      await client.query(
        `UPDATE accounts
            SET review_flagged = TRUE,
                review_flag_reason = $2,
                updated_at = NOW()
          WHERE id = $1`,
        [acc.id, String(reason || 'Flagged by auto enforcement')]
      )
      message = 'Account flagged for manual review'
    } else {
      eventStatus = 'failed'
      message = `Unsupported action: ${action}`
    }

    const eventResult = await client.query(
      `INSERT INTO admin_enforcement_events (rule_id, account_id, user_id, action, payload_json, status, message)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       RETURNING *`,
      [
        Number.isFinite(parseInt(rule_id, 10)) ? parseInt(rule_id, 10) : null,
        String(acc.id),
        String(acc.user_id),
        String(action),
        JSON.stringify(payload || {}),
        eventStatus,
        message
      ]
    )

    if (rule_id && eventStatus === 'applied') {
      await client.query(
        `UPDATE admin_rules
            SET trigger_count = trigger_count + 1,
                last_triggered_at = NOW(),
                updated_at = NOW()
          WHERE id = $1`,
        [parseInt(rule_id, 10)]
      )
    }
    try {
      await appendImmutableAudit(client, {
        eventType: 'enforcement_applied',
        entityType: 'account',
        entityId: String(acc.id),
        payload: {
          action: String(action),
          status: eventStatus,
          rule_id: Number.isFinite(parseInt(rule_id, 10)) ? parseInt(rule_id, 10) : null
        }
      })
    } catch (_) {}

    await client.query('COMMIT')
    res.json({ message, event: eventResult.rows[0] })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to apply enforcement action' })
  } finally {
    client.release()
  }
})

router.get('/payout-fraud-scores', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT p.id, p.user_id, p.account_id, p.amount_requested, p.status, p.requested_at,
              u.full_name, u.email, u.kyc_status,
              a.account_size, a.created_at AS account_created_at
         FROM payouts p
         JOIN users u ON u.id = p.user_id
         JOIN accounts a ON a.id = p.account_id
        WHERE p.status IN ('pending', 'flagged')
        ORDER BY p.requested_at DESC
        LIMIT 250`
    )

    const scored = []
    for (const row of result.rows) {
      let score = 0
      const reasons = []
      const amount = parseFloat(row.amount_requested || 0)
      const accountSize = parseFloat(row.account_size || 0)
      const accountAgeDays = Math.max(0, Math.floor((Date.now() - new Date(row.account_created_at).getTime()) / (1000 * 60 * 60 * 24)))

      if (accountSize > 0 && amount > accountSize * 0.2) {
        score += 30
        reasons.push('Large payout relative to account size')
      }
      if (String(row.kyc_status) !== 'approved') {
        score += 25
        reasons.push('KYC not approved')
      }
      if (accountAgeDays < 7) {
        score += 20
        reasons.push('Very new account')
      }

      const openTrades = await pool.query(
        `SELECT COUNT(*)::int AS c FROM trades WHERE account_id = $1 AND status = 'open'`,
        [row.account_id]
      )
      if ((openTrades.rows[0]?.c || 0) > 0) {
        score += 10
        reasons.push('Open trades exist at payout request time')
      }

      const recentTrades = await pool.query(
        `SELECT COUNT(*)::int AS c
           FROM trades
          WHERE account_id = $1
            AND close_time >= NOW() - INTERVAL '24 hours'`,
        [row.account_id]
      )
      if ((recentTrades.rows[0]?.c || 0) >= 10) {
        score += 10
        reasons.push('High recent trade velocity')
      }

      let sharedUsers = 1
      try {
        const lastLoginIp = await pool.query(
          `SELECT ip_address FROM login_logs
            WHERE user_id = $1 AND ip_address IS NOT NULL
            ORDER BY logged_in_at DESC LIMIT 1`,
          [row.user_id]
        )
        const ip = lastLoginIp.rows[0]?.ip_address
        if (ip) {
          const shared = await pool.query(
            `SELECT COUNT(DISTINCT user_id)::int AS c
               FROM login_logs
              WHERE ip_address = $1
                AND logged_in_at >= NOW() - INTERVAL '30 days'`,
            [ip]
          )
          sharedUsers = shared.rows[0]?.c || 1
          if (sharedUsers >= 3) {
            score += 20
            reasons.push('IP shared by multiple users')
          }
        }
      } catch (_) {}

      const risk_level = score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low'
      scored.push({
        ...row,
        score,
        risk_level,
        account_age_days: accountAgeDays,
        shared_ip_users: sharedUsers,
        reasons
      })
    }

    scored.sort((a, b) => b.score - a.score)
    res.json(scored)
  } catch (err) {
    res.status(500).json({ error: 'Failed to compute payout fraud scores' })
  }
})

router.get('/device-link-graph', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const focusUserId = req.query.user_id ? String(req.query.user_id) : null

    const loginRows = await pool.query(
      `SELECT user_id, ip_address, logged_in_at
         FROM login_logs
        WHERE ip_address IS NOT NULL
          AND logged_in_at >= NOW() - INTERVAL '30 days'
        ORDER BY logged_in_at DESC
        LIMIT 3000`
    )
    const tradeRows = await pool.query(
      `SELECT user_id, account_id, ip_address, logged_at
         FROM trade_logs
        WHERE ip_address IS NOT NULL
          AND logged_at >= NOW() - INTERVAL '30 days'
        ORDER BY logged_at DESC
        LIMIT 3000`
    )

    const allowedUsers = new Set()
    if (focusUserId) {
      allowedUsers.add(focusUserId)
      for (const r of loginRows.rows) {
        if (String(r.user_id) === focusUserId) allowedUsers.add(String(r.user_id))
      }
      for (const r of tradeRows.rows) {
        if (String(r.user_id) === focusUserId) allowedUsers.add(String(r.user_id))
      }
    }

    const nodes = new Map()
    const edges = new Map()
    function addNode(id, type, label) {
      if (!nodes.has(id)) nodes.set(id, { id, type, label })
    }
    function addEdge(from, to, type) {
      const key = `${from}|${to}|${type}`
      const prev = edges.get(key)
      if (prev) prev.weight += 1
      else edges.set(key, { id: key, from, to, type, weight: 1 })
    }

    for (const r of loginRows.rows) {
      const uid = String(r.user_id || '')
      const ip = String(r.ip_address || '')
      if (!uid || !ip) continue
      if (focusUserId && uid !== focusUserId) continue
      const uNode = `u:${uid}`
      const ipNode = `ip:${ip}`
      addNode(uNode, 'user', uid)
      addNode(ipNode, 'ip', ip)
      addEdge(uNode, ipNode, 'login_ip')
    }

    for (const r of tradeRows.rows) {
      const uid = String(r.user_id || '')
      const acc = String(r.account_id || '')
      const ip = String(r.ip_address || '')
      if (!uid || !ip) continue
      if (focusUserId && uid !== focusUserId) continue
      const uNode = `u:${uid}`
      const aNode = `a:${acc}`
      const ipNode = `ip:${ip}`
      addNode(uNode, 'user', uid)
      addNode(aNode, 'account', acc)
      addNode(ipNode, 'ip', ip)
      addEdge(uNode, ipNode, 'trade_ip')
      if (acc) addEdge(aNode, ipNode, 'account_ip')
      if (acc) addEdge(uNode, aNode, 'owns')
    }

    res.json({
      generated_at: new Date(),
      nodes: Array.from(nodes.values()),
      edges: Array.from(edges.values())
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to build device link graph' })
  }
})

router.get('/news-protection', authenticateAdmin, async (req, res) => {
  try {
    const keys = [
      'news_protection_enabled',
      'news_protection_lookahead_minutes',
      'news_protection_max_lots_multiplier',
      'news_protection_block_new_orders',
    ]
    const s = await getSettingsMap(keys)
    res.json({
      enabled: toBool(s.news_protection_enabled, false),
      lookahead_minutes: parseInt(s.news_protection_lookahead_minutes || '3', 10),
      max_lots_multiplier: parseFloat(s.news_protection_max_lots_multiplier || '0.6'),
      block_new_orders: toBool(s.news_protection_block_new_orders, true),
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load news protection settings' })
  }
})

router.post('/news-protection', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    const body = req.body || {}
    await client.query('BEGIN')
    await upsertSetting(client, 'news_protection_enabled', toBool(body.enabled, false))
    await upsertSetting(client, 'news_protection_lookahead_minutes', Math.max(0, parseInt(body.lookahead_minutes || 3, 10)))
    await upsertSetting(client, 'news_protection_max_lots_multiplier', Math.max(0.05, parseFloat(body.max_lots_multiplier || 0.6)))
    await upsertSetting(client, 'news_protection_block_new_orders', toBool(body.block_new_orders, true))
    try {
      await appendImmutableAudit(client, {
        eventType: 'news_protection_updated',
        entityType: 'risk_setting',
        entityId: 'news_protection',
        payload: {
          enabled: toBool(body.enabled, false),
          lookahead_minutes: Math.max(0, parseInt(body.lookahead_minutes || 3, 10)),
          max_lots_multiplier: Math.max(0.05, parseFloat(body.max_lots_multiplier || 0.6)),
          block_new_orders: toBool(body.block_new_orders, true)
        }
      })
    } catch (_) {}
    await client.query('COMMIT')
    res.json({ message: 'News protection settings saved' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to save news protection settings' })
  } finally {
    client.release()
  }
})

router.get('/rollover-guard', authenticateAdmin, async (req, res) => {
  try {
    const keys = [
      'rollover_guard_enabled',
      'rollover_guard_start_utc',
      'rollover_guard_end_utc',
      'rollover_guard_block_new_orders',
    ]
    const s = await getSettingsMap(keys)
    res.json({
      enabled: toBool(s.rollover_guard_enabled, true),
      start_utc: s.rollover_guard_start_utc || '21:55',
      end_utc: s.rollover_guard_end_utc || '22:05',
      block_new_orders: toBool(s.rollover_guard_block_new_orders, true),
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load rollover guard settings' })
  }
})

router.post('/rollover-guard', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    const body = req.body || {}
    await client.query('BEGIN')
    await upsertSetting(client, 'rollover_guard_enabled', toBool(body.enabled, true))
    await upsertSetting(client, 'rollover_guard_start_utc', String(body.start_utc || '21:55'))
    await upsertSetting(client, 'rollover_guard_end_utc', String(body.end_utc || '22:05'))
    await upsertSetting(client, 'rollover_guard_block_new_orders', toBool(body.block_new_orders, true))
    try {
      await appendImmutableAudit(client, {
        eventType: 'rollover_guard_updated',
        entityType: 'risk_setting',
        entityId: 'rollover_guard',
        payload: {
          enabled: toBool(body.enabled, true),
          start_utc: String(body.start_utc || '21:55'),
          end_utc: String(body.end_utc || '22:05'),
          block_new_orders: toBool(body.block_new_orders, true)
        }
      })
    } catch (_) {}
    await client.query('COMMIT')
    res.json({ message: 'Rollover guard settings saved' })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to save rollover guard settings' })
  } finally {
    client.release()
  }
})

router.get('/slippage-monitor', authenticateAdmin, async (req, res) => {
  try {
    const prices = await pool.query(
      `SELECT instrument, bid, ask, updated_at
         FROM price_feed`
    )
    const recent = await pool.query(
      `SELECT instrument, direction, open_price, close_price, open_time, close_time
         FROM trades
        WHERE status = 'closed'
          AND close_time >= NOW() - INTERVAL '24 hours'
          AND open_price IS NOT NULL
          AND close_price IS NOT NULL
        ORDER BY close_time DESC
        LIMIT 3000`
    )

    const spreadRows = prices.rows.map(r => {
      const bid = parseFloat(r.bid || 0)
      const ask = parseFloat(r.ask || 0)
      const spreadAbs = Math.max(0, ask - bid)
      const isMetal = ['XAUUSD', 'XAGUSD'].includes(r.instrument)
      const spreadPoints = isMetal ? spreadAbs * 100 : spreadAbs * 100000
      const threshold = isMetal ? 80 : 4.5
      return {
        instrument: r.instrument,
        spread_points: parseFloat(spreadPoints.toFixed(2)),
        threshold_points: threshold,
        is_alert: spreadPoints > threshold,
        updated_at: r.updated_at || null,
      }
    })

    let suspicious = 0
    let sampleCount = 0
    const byInstrument = {}
    for (const t of recent.rows) {
      const openPrice = parseFloat(t.open_price || 0)
      const closePrice = parseFloat(t.close_price || 0)
      const holdSec = Math.max(0, (new Date(t.close_time).getTime() - new Date(t.open_time).getTime()) / 1000)
      const isMetal = ['XAUUSD', 'XAGUSD'].includes(t.instrument)
      const points = Math.abs(closePrice - openPrice) * (isMetal ? 100 : 100000)
      sampleCount += 1

      if (!byInstrument[t.instrument]) byInstrument[t.instrument] = { instrument: t.instrument, trades: 0, avg_move_points: 0, suspicious_quick_moves: 0 }
      byInstrument[t.instrument].trades += 1
      byInstrument[t.instrument].avg_move_points += points

      if (holdSec < 60 && points > (isMetal ? 120 : 20)) {
        suspicious += 1
        byInstrument[t.instrument].suspicious_quick_moves += 1
      }
    }

    const drift = Object.values(byInstrument).map(r => ({
      ...r,
      avg_move_points: r.trades > 0 ? parseFloat((r.avg_move_points / r.trades).toFixed(2)) : 0
    })).sort((a, b) => b.suspicious_quick_moves - a.suspicious_quick_moves)

    res.json({
      generated_at: new Date(),
      spread_monitor: spreadRows.sort((a, b) => (b.is_alert ? 1 : 0) - (a.is_alert ? 1 : 0)),
      drift_monitor: drift,
      suspicious_quick_moves: suspicious,
      sample_count: sampleCount,
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load slippage monitor' })
  }
})

router.get('/feed-anomalies', authenticateAdmin, async (req, res) => {
  try {
    const settings = await getSettingsMap(['feed_stale_threshold_seconds'])
    const staleThreshold = Math.max(5, parseInt(settings.feed_stale_threshold_seconds || '30', 10))

    const result = await pool.query(`SELECT instrument, bid, ask, updated_at FROM price_feed`)
    const now = Date.now()
    const rows = []
    let staleCount = 0
    let wideSpreadCount = 0

    for (const r of result.rows) {
      const bid = parseFloat(r.bid || 0)
      const ask = parseFloat(r.ask || 0)
      const spreadAbs = Math.max(0, ask - bid)
      const isMetal = ['XAUUSD', 'XAGUSD'].includes(r.instrument)
      const spreadPoints = isMetal ? spreadAbs * 100 : spreadAbs * 100000
      const spreadThreshold = isMetal ? 80 : 4.5
      const ageSec = r.updated_at ? Math.max(0, Math.floor((now - new Date(r.updated_at).getTime()) / 1000)) : 999999
      const stale = ageSec > staleThreshold
      const wide = spreadPoints > spreadThreshold
      if (stale) staleCount += 1
      if (wide) wideSpreadCount += 1

      rows.push({
        instrument: r.instrument,
        bid,
        ask,
        spread_points: parseFloat(spreadPoints.toFixed(2)),
        spread_threshold: spreadThreshold,
        seconds_since_update: ageSec,
        stale,
        wide_spread: wide,
      })
    }

    const anomalies = rows.filter(r => r.stale || r.wide_spread)
    res.json({
      generated_at: new Date(),
      stale_threshold_seconds: staleThreshold,
      stale_count: staleCount,
      wide_spread_count: wideSpreadCount,
      any_anomaly: anomalies.length > 0,
      instruments: rows,
      anomalies
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load feed anomalies' })
  }
})

router.get('/challenge-funnel', authenticateAdmin, async (req, res) => {
  try {
    const totals = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE account_type = 'phase1') AS phase1_total,
         COUNT(*) FILTER (WHERE account_type = 'phase1' AND status = 'passed') AS phase1_passed,
         COUNT(*) FILTER (WHERE account_type = 'phase2') AS phase2_total,
         COUNT(*) FILTER (WHERE account_type = 'phase2' AND status = 'passed') AS phase2_passed,
         COUNT(*) FILTER (WHERE account_type = 'funded') AS funded_total,
         COUNT(*) FILTER (WHERE account_type = 'funded' AND status = 'active') AS funded_active,
         COUNT(*) FILTER (WHERE status = 'failed') AS failed_total,
         COUNT(*) FILTER (WHERE status = 'expired') AS expired_total
       FROM accounts`
    )

    const r = totals.rows[0] || {}
    const phase1Total = parseInt(r.phase1_total || 0, 10)
    const phase1Passed = parseInt(r.phase1_passed || 0, 10)
    const phase2Total = parseInt(r.phase2_total || 0, 10)
    const phase2Passed = parseInt(r.phase2_passed || 0, 10)
    const fundedTotal = parseInt(r.funded_total || 0, 10)
    const fundedActive = parseInt(r.funded_active || 0, 10)
    const failedTotal = parseInt(r.failed_total || 0, 10)
    const expiredTotal = parseInt(r.expired_total || 0, 10)

    const phase1PassRate = phase1Total > 0 ? parseFloat(((phase1Passed / phase1Total) * 100).toFixed(2)) : 0
    const phase2PassRate = phase2Total > 0 ? parseFloat(((phase2Passed / phase2Total) * 100).toFixed(2)) : 0
    const fundedActivationRate = fundedTotal > 0 ? parseFloat(((fundedActive / fundedTotal) * 100).toFixed(2)) : 0

    res.json({
      generated_at: new Date(),
      funnel: {
        phase1_total: phase1Total,
        phase1_passed: phase1Passed,
        phase1_pass_rate: phase1PassRate,
        phase2_total: phase2Total,
        phase2_passed: phase2Passed,
        phase2_pass_rate: phase2PassRate,
        funded_total: fundedTotal,
        funded_active: fundedActive,
        funded_activation_rate: fundedActivationRate,
      },
      outcomes: {
        failed_total: failedTotal,
        expired_total: expiredTotal,
      }
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load challenge funnel' })
  }
})

router.get('/cohort-analytics', authenticateAdmin, async (req, res) => {
  try {
    const monthsBackRaw = parseInt(req.query.months || '12', 10)
    const monthsBack = Number.isFinite(monthsBackRaw) ? Math.max(3, Math.min(24, monthsBackRaw)) : 12
    const cohorts = await pool.query(
      `WITH user_base AS (
         SELECT
           u.id,
           DATE_TRUNC('month', u.created_at) AS cohort_month,
           CASE
             WHEN COALESCE(NULLIF(TRIM(u.referred_by), ''), '') <> '' THEN 'referral'
             ELSE 'direct'
           END AS source,
           COALESCE(NULLIF(TRIM(u.country), ''), 'UNKNOWN') AS country,
           COALESCE(u.kyc_status, 'pending') AS kyc_status
         FROM users u
         WHERE u.created_at >= NOW() - make_interval(months => $1::int)
       ),
       account_agg AS (
         SELECT
           a.user_id,
           COUNT(*)::int AS accounts_opened,
           COUNT(*) FILTER (WHERE a.account_type = 'funded')::int AS funded_accounts
         FROM accounts a
         GROUP BY a.user_id
       ),
       payout_agg AS (
         SELECT
           p.user_id,
           COALESCE(SUM(p.amount) FILTER (WHERE p.status = 'paid'), 0)::numeric AS paid_out
         FROM payouts p
         GROUP BY p.user_id
       )
       SELECT
         ub.cohort_month,
         ub.source,
         ub.country,
         COUNT(*)::int AS signups,
         COUNT(*) FILTER (WHERE ub.kyc_status = 'approved')::int AS kyc_approved,
         COALESCE(SUM(COALESCE(aa.accounts_opened, 0)), 0)::int AS accounts_opened,
         COALESCE(SUM(COALESCE(aa.funded_accounts, 0)), 0)::int AS funded_accounts,
         COALESCE(SUM(COALESCE(pa.paid_out, 0)), 0)::numeric AS paid_out
       FROM user_base ub
       LEFT JOIN account_agg aa ON aa.user_id = ub.id
       LEFT JOIN payout_agg pa ON pa.user_id = ub.id
       GROUP BY ub.cohort_month, ub.source, ub.country
       ORDER BY ub.cohort_month DESC, signups DESC`,
      [monthsBack]
    )

    const rows = cohorts.rows.map(r => ({
      cohort_month: r.cohort_month,
      source: r.source,
      country: r.country,
      signups: parseInt(r.signups || 0, 10),
      kyc_approved: parseInt(r.kyc_approved || 0, 10),
      accounts_opened: parseInt(r.accounts_opened || 0, 10),
      funded_accounts: parseInt(r.funded_accounts || 0, 10),
      paid_out: parseFloat(r.paid_out || 0),
    }))

    const monthlyMap = new Map()
    const countryMap = new Map()
    for (const r of rows) {
      const monthKey = r.cohort_month ? new Date(r.cohort_month).toISOString().slice(0, 7) : 'unknown'
      const m = monthlyMap.get(monthKey) || {
        month: monthKey,
        signups: 0,
        kyc_approved: 0,
        funded_accounts: 0,
        paid_out: 0
      }
      m.signups += r.signups
      m.kyc_approved += r.kyc_approved
      m.funded_accounts += r.funded_accounts
      m.paid_out += r.paid_out
      monthlyMap.set(monthKey, m)

      const c = countryMap.get(r.country) || { country: r.country, signups: 0 }
      c.signups += r.signups
      countryMap.set(r.country, c)
    }

    const monthly = Array.from(monthlyMap.values())
      .sort((a, b) => b.month.localeCompare(a.month))
      .map(m => ({
        ...m,
        kyc_approval_rate: m.signups > 0 ? parseFloat(((m.kyc_approved / m.signups) * 100).toFixed(2)) : 0
      }))
    const top_countries = Array.from(countryMap.values())
      .sort((a, b) => b.signups - a.signups)
      .slice(0, 12)

    res.json({
      generated_at: new Date(),
      months_back: monthsBack,
      cohorts: rows,
      monthly,
      top_countries
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cohort analytics' })
  }
})

router.get('/aml-velocity', authenticateAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `WITH active_users AS (
         SELECT DISTINCT user_id::text FROM login_logs WHERE logged_in_at >= NOW() - INTERVAL '24 hours'
         UNION
         SELECT DISTINCT user_id::text FROM trade_logs WHERE logged_at >= NOW() - INTERVAL '24 hours'
         UNION
         SELECT DISTINCT user_id::text FROM payouts WHERE requested_at >= NOW() - INTERVAL '7 days'
       ),
       login_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '1 hour')::int AS login_1h,
           COUNT(*) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '24 hours')::int AS login_24h,
           COUNT(DISTINCT ip_address) FILTER (WHERE logged_in_at >= NOW() - INTERVAL '24 hours' AND ip_address IS NOT NULL)::int AS unique_ip_24h
         FROM login_logs
         GROUP BY user_id::text
       ),
       trade_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '1 hour')::int AS trade_1h,
           COUNT(*) FILTER (WHERE logged_at >= NOW() - INTERVAL '24 hours')::int AS trade_24h
         FROM trade_logs
         GROUP BY user_id::text
       ),
       payout_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*) FILTER (WHERE requested_at >= NOW() - INTERVAL '7 days')::int AS payout_req_7d,
           COALESCE(SUM(amount_requested) FILTER (WHERE requested_at >= NOW() - INTERVAL '7 days'), 0)::numeric AS payout_amt_7d
         FROM payouts
         GROUP BY user_id::text
       ),
       account_agg AS (
         SELECT
           user_id::text AS user_id,
           COUNT(*)::int AS accounts_total,
           COUNT(*) FILTER (WHERE status = 'active')::int AS active_accounts
         FROM accounts
         GROUP BY user_id::text
       )
       SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         u.kyc_status,
         COALESCE(l.login_1h, 0)::int AS login_1h,
         COALESCE(l.login_24h, 0)::int AS login_24h,
         COALESCE(l.unique_ip_24h, 0)::int AS unique_ip_24h,
         COALESCE(t.trade_1h, 0)::int AS trade_1h,
         COALESCE(t.trade_24h, 0)::int AS trade_24h,
         COALESCE(p.payout_req_7d, 0)::int AS payout_req_7d,
         COALESCE(p.payout_amt_7d, 0)::numeric AS payout_amt_7d,
         COALESCE(a.accounts_total, 0)::int AS accounts_total,
         COALESCE(a.active_accounts, 0)::int AS active_accounts
       FROM active_users au
       JOIN users u ON u.id::text = au.user_id
       LEFT JOIN login_agg l ON l.user_id = u.id::text
       LEFT JOIN trade_agg t ON t.user_id = u.id::text
       LEFT JOIN payout_agg p ON p.user_id = u.id::text
       LEFT JOIN account_agg a ON a.user_id = u.id::text
       ORDER BY
         (COALESCE(l.login_1h, 0) + COALESCE(l.login_24h, 0) + COALESCE(t.trade_1h, 0) + COALESCE(t.trade_24h, 0) + COALESCE(p.payout_req_7d, 0)) DESC,
         COALESCE(p.payout_amt_7d, 0) DESC
       LIMIT 300`
    )

    const rows = []
    for (const r of result.rows) {
      let riskScore = 0
      const flags = []

      if (r.login_1h >= 8) { riskScore += 25; flags.push('High login burst (1h)') }
      if (r.login_24h >= 25) { riskScore += 15; flags.push('High login velocity (24h)') }
      if (r.unique_ip_24h >= 4) { riskScore += 20; flags.push('Many unique IPs (24h)') }
      if (r.trade_1h >= 30) { riskScore += 20; flags.push('Trade burst (1h)') }
      if (r.trade_24h >= 120) { riskScore += 20; flags.push('High trade count (24h)') }
      if (r.payout_req_7d >= 2) { riskScore += 15; flags.push('Multiple payout requests (7d)') }
      if (parseFloat(r.payout_amt_7d || 0) >= 10000) { riskScore += 10; flags.push('Large payout amount (7d)') }
      if (String(r.kyc_status || '') !== 'approved') { riskScore += 10; flags.push('KYC not approved') }

      if (riskScore <= 0) continue
      rows.push({
        ...r,
        payout_amt_7d: parseFloat(r.payout_amt_7d || 0),
        risk_score: riskScore,
        risk_level: riskScore >= 70 ? 'high' : riskScore >= 40 ? 'medium' : 'low',
        flags
      })
    }

    rows.sort((a, b) => b.risk_score - a.risk_score)
    const sliced = rows.slice(0, 200)
    res.json({
      generated_at: new Date(),
      flagged_count: sliced.length,
      high_risk_count: sliced.filter(r => r.risk_level === 'high').length,
      medium_risk_count: sliced.filter(r => r.risk_level === 'medium').length,
      rows: sliced
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load AML velocity checks' })
  }
})

router.get('/kyc-sla', authenticateAdmin, async (req, res) => {
  try {
    const slaHoursRaw = parseInt(req.query.sla_hours || '24', 10)
    const slaHours = Number.isFinite(slaHoursRaw) ? Math.max(1, Math.min(168, slaHoursRaw)) : 24

    const pending = await pool.query(
      `SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         COALESCE(NULLIF(TRIM(u.country), ''), 'UNKNOWN') AS country,
         COALESCE(u.kyc_submitted_at, u.created_at) AS submitted_at,
         EXTRACT(EPOCH FROM (NOW() - COALESCE(u.kyc_submitted_at, u.created_at))) / 3600.0 AS wait_hours,
         COUNT(a.id)::int AS accounts_total,
         COUNT(*) FILTER (WHERE a.account_type = 'funded')::int AS funded_accounts
       FROM users u
       LEFT JOIN accounts a ON a.user_id = u.id
       WHERE u.kyc_status = 'pending'
       GROUP BY u.id, u.full_name, u.email, u.country, u.kyc_submitted_at, u.created_at
       ORDER BY COALESCE(u.kyc_submitted_at, u.created_at) ASC
       LIMIT 600`
    )

    const queue = pending.rows.map(r => {
      const waitHours = parseFloat(r.wait_hours || 0)
      const sla_status =
        waitHours >= slaHours * 2 ? 'breach'
          : waitHours >= slaHours ? 'overdue'
            : waitHours >= slaHours * 0.6 ? 'warning'
              : 'within_sla'
      return {
        ...r,
        wait_hours: parseFloat(waitHours.toFixed(2)),
        wait_minutes: Math.max(0, Math.floor(waitHours * 60)),
        sla_status
      }
    })

    const pendingTotal = queue.length
    const overdueCount = queue.filter(r => r.sla_status === 'overdue' || r.sla_status === 'breach').length
    const breachCount = queue.filter(r => r.sla_status === 'breach').length
    const avgWaitHours = pendingTotal > 0
      ? parseFloat((queue.reduce((s, r) => s + (r.wait_hours || 0), 0) / pendingTotal).toFixed(2))
      : 0

    res.json({
      generated_at: new Date(),
      sla_hours: slaHours,
      summary: {
        pending_total: pendingTotal,
        overdue_total: overdueCount,
        breach_total: breachCount,
        avg_wait_hours: avgWaitHours
      },
      queue
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load KYC SLA queue' })
  }
})

router.get('/kyc-quality-flags', authenticateAdmin, async (req, res) => {
  try {
    const uploadsRoot = path.resolve(__dirname, '../uploads')
    const docs = await pool.query(
      `SELECT
         u.id::text AS user_id,
         u.full_name,
         u.email,
         u.kyc_status,
         COALESCE(u.kyc_submitted_at, u.created_at) AS submitted_at,
         u.id_document_path,
         u.selfie_path
       FROM users u
       WHERE u.id_document_path IS NOT NULL OR u.selfie_path IS NOT NULL
       ORDER BY COALESCE(u.kyc_submitted_at, u.created_at) DESC
       LIMIT 500`
    )

    function inspectRelativeFile(relPath) {
      if (!relPath) return { exists: false, size_bytes: 0, ext: '' }
      const raw = String(relPath).replace(/^[/\\]+/, '')
      const safe = raw.replace(/\.\./g, '')
      const abs = path.resolve(uploadsRoot, safe)
      if (!abs.startsWith(uploadsRoot + path.sep) && abs !== uploadsRoot) {
        return { exists: false, size_bytes: 0, ext: path.extname(raw).toLowerCase() }
      }
      try {
        if (!fs.existsSync(abs)) return { exists: false, size_bytes: 0, ext: path.extname(raw).toLowerCase() }
        const st = fs.statSync(abs)
        return { exists: true, size_bytes: st.size, ext: path.extname(raw).toLowerCase() }
      } catch {
        return { exists: false, size_bytes: 0, ext: path.extname(raw).toLowerCase() }
      }
    }

    const rows = docs.rows.map(r => {
      const idFile = inspectRelativeFile(r.id_document_path)
      const selfieFile = inspectRelativeFile(r.selfie_path)
      const flags = []
      let qualityScore = 0

      if (!idFile.exists) { flags.push('Missing ID document file'); qualityScore += 50 }
      if (!selfieFile.exists) { flags.push('Missing selfie file'); qualityScore += 50 }

      if (idFile.exists && !['.jpg', '.jpeg', '.png', '.pdf'].includes(idFile.ext)) {
        flags.push('Unexpected ID document extension')
        qualityScore += 20
      }
      if (selfieFile.exists && !['.jpg', '.jpeg', '.png'].includes(selfieFile.ext)) {
        flags.push('Unexpected selfie extension')
        qualityScore += 25
      }
      if (idFile.exists && idFile.ext !== '.pdf' && idFile.size_bytes < 70 * 1024) {
        flags.push('ID image file very small')
        qualityScore += 20
      }
      if (selfieFile.exists && selfieFile.size_bytes < 60 * 1024) {
        flags.push('Selfie file very small')
        qualityScore += 25
      }
      if (idFile.exists && selfieFile.exists && (idFile.size_bytes + selfieFile.size_bytes) < 180 * 1024) {
        flags.push('Combined KYC payload unusually small')
        qualityScore += 15
      }

      const submittedAt = r.submitted_at ? new Date(r.submitted_at) : null
      if (submittedAt && String(r.kyc_status || '') === 'pending') {
        const ageHours = (Date.now() - submittedAt.getTime()) / 3600000
        if (ageHours >= 48) {
          flags.push('Pending review for more than 48 hours')
          qualityScore += 10
        }
      }

      return {
        ...r,
        id_file_exists: idFile.exists,
        id_file_size: idFile.size_bytes,
        selfie_file_exists: selfieFile.exists,
        selfie_file_size: selfieFile.size_bytes,
        quality_score: qualityScore,
        risk_level: qualityScore >= 60 ? 'high' : qualityScore >= 30 ? 'medium' : 'low',
        flags
      }
    }).sort((a, b) => b.quality_score - a.quality_score)

    res.json({
      generated_at: new Date(),
      summary: {
        total_profiles: rows.length,
        high_risk_count: rows.filter(r => r.risk_level === 'high').length,
        medium_risk_count: rows.filter(r => r.risk_level === 'medium').length,
        missing_file_count: rows.filter(r => !r.id_file_exists || !r.selfie_file_exists).length
      },
      rows
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load KYC quality flags' })
  }
})

router.get('/immutable-audit', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const countResult = await pool.query(`SELECT COUNT(*)::int AS c FROM admin_immutable_audit`)
    if ((countResult.rows[0]?.c || 0) === 0) {
      try {
        await appendImmutableAudit(pool, {
          eventType: 'audit_chain_initialized',
          entityType: 'system',
          entityId: 'bootstrap',
          payload: { initialized_at: new Date().toISOString() }
        })
      } catch (_) {}
    }

    const result = await pool.query(
      `SELECT
         id,
         event_type,
         entity_type,
         entity_id,
         actor,
         payload_json,
         payload_text,
         prev_hash,
         entry_hash,
         created_at
       FROM admin_immutable_audit
       ORDER BY id DESC
       LIMIT 500`
    )

    const descRows = result.rows
    const ascRows = [...descRows].reverse()
    let expectedPrev = 'GENESIS'
    let brokenLinks = 0
    const validatedAsc = ascRows.map(r => {
      const payloadText = String(r.payload_text || normalizeAuditPayload(r.payload_json || {}))
      const createdAt = r.created_at ? new Date(r.created_at).toISOString() : ''
      const expectedHash = buildAuditHash({
        prevHash: r.prev_hash,
        eventType: r.event_type,
        entityType: r.entity_type,
        entityId: r.entity_id,
        payloadText,
        createdAt
      })
      const isValid = r.prev_hash === expectedPrev && r.entry_hash === expectedHash
      if (!isValid) brokenLinks += 1
      expectedPrev = r.entry_hash
      return { ...r, is_valid: isValid }
    })

    const entries = validatedAsc.reverse()
    res.json({
      generated_at: new Date(),
      integrity: {
        valid: brokenLinks === 0,
        broken_links: brokenLinks,
        checked_entries: validatedAsc.length,
        chain_head: entries[0]?.entry_hash || null
      },
      entries
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load immutable audit log' })
  }
})

router.get('/four-eyes/queue', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT
         id, action_type, target_type, target_id, payload_json, requested_by,
         approvals_json, required_approvals, status, created_at, updated_at, decided_at,
         COALESCE(jsonb_array_length(approvals_json), 0)::int AS approvals_count
       FROM admin_four_eyes_requests
       ORDER BY created_at DESC
       LIMIT 300`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load 4-eyes queue' })
  }
})

router.post('/four-eyes/request', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      action_type,
      target_type = 'generic',
      target_id = '',
      payload = {},
      required_approvals = 2,
      requested_by = 'admin'
    } = req.body || {}

    if (!action_type || String(action_type).trim().length < 3) {
      return res.status(400).json({ error: 'action_type is required (min 3 chars)' })
    }
    const requiredApprovals = Math.max(2, Math.min(5, parseInt(required_approvals, 10) || 2))
    const ins = await pool.query(
      `INSERT INTO admin_four_eyes_requests
        (action_type, target_type, target_id, payload_json, requested_by, required_approvals, status, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, 'pending', NOW())
       RETURNING *`,
      [
        String(action_type).trim(),
        String(target_type || 'generic').trim(),
        String(target_id || '').trim(),
        JSON.stringify(payload || {}),
        String(requested_by || 'admin').trim(),
        requiredApprovals
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'four_eyes_request_created',
        entityType: 'four_eyes_request',
        entityId: String(ins.rows[0].id),
        payload: {
          action_type: String(action_type).trim(),
          required_approvals: requiredApprovals
        }
      })
    } catch (_) {}
    res.status(201).json(ins.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create 4-eyes request' })
  }
})

router.post('/four-eyes/:id/decision', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const decision = String(req.body?.decision || '').trim().toLowerCase()
    const approver = String(req.body?.approver || 'admin').trim()
    const comment = String(req.body?.comment || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid request id' })
    if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ error: 'decision must be approve or reject' })

    await client.query('BEGIN')
    const currentResult = await client.query(
      `SELECT id, action_type, target_type, target_id, payload_json, requested_by,
              approvals_json, required_approvals, status, created_at, updated_at, decided_at
       FROM admin_four_eyes_requests WHERE id = $1 FOR UPDATE`,
      [id]
    )
    if (currentResult.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Request not found' })
    }

    const current = currentResult.rows[0]
    if (current.status !== 'pending') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: `Request already ${current.status}` })
    }

    const approvals = Array.isArray(current.approvals_json) ? [...current.approvals_json] : []
    if (approvals.some(a => String(a.approver || '') === approver)) {
      await client.query('ROLLBACK')
      return res.status(409).json({ error: 'Approver has already submitted a decision' })
    }
    approvals.push({
      approver,
      decision,
      comment,
      at: new Date().toISOString()
    })

    const approvedCount = approvals.filter(a => a.decision === 'approve').length
    const rejectedCount = approvals.filter(a => a.decision === 'reject').length
    const needed = Math.max(2, parseInt(current.required_approvals || 2, 10))
    const nextStatus = rejectedCount > 0 ? 'rejected' : approvedCount >= needed ? 'approved' : 'pending'
    const decidedAt = nextStatus === 'pending' ? null : new Date().toISOString()

    const update = await client.query(
      `UPDATE admin_four_eyes_requests
          SET approvals_json = $2::jsonb,
              status = $3,
              decided_at = $4::timestamptz,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *,
                  COALESCE(jsonb_array_length(approvals_json), 0)::int AS approvals_count`,
      [id, JSON.stringify(approvals), nextStatus, decidedAt]
    )

    try {
      await appendImmutableAudit(client, {
        eventType: 'four_eyes_decision_submitted',
        entityType: 'four_eyes_request',
        entityId: String(id),
        payload: {
          decision,
          approver,
          resulting_status: nextStatus,
          approvals_count: approvals.length
        }
      })
    } catch (_) {}

    await client.query('COMMIT')
    res.json(update.rows[0])
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to submit 4-eyes decision' })
  } finally {
    client.release()
  }
})

router.get('/feature-flags', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT id, flag_key, description, enabled, rollout_pct, segment, updated_by,
              created_at, updated_at
       FROM admin_feature_flags ORDER BY flag_key ASC`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load feature flags' })
  }
})

router.post('/feature-flags', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      flag_key,
      description = '',
      enabled = false,
      rollout_pct = 100,
      segment = 'all',
      updated_by = 'admin'
    } = req.body || {}
    if (!flag_key || String(flag_key).trim().length < 2) {
      return res.status(400).json({ error: 'flag_key is required (min 2 chars)' })
    }
    const rollout = Math.max(0, Math.min(100, parseInt(rollout_pct, 10) || 0))
    const upsert = await pool.query(
      `INSERT INTO admin_feature_flags
        (flag_key, description, enabled, rollout_pct, segment, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (flag_key)
       DO UPDATE SET
         description = EXCLUDED.description,
         enabled = EXCLUDED.enabled,
         rollout_pct = EXCLUDED.rollout_pct,
         segment = EXCLUDED.segment,
         updated_by = EXCLUDED.updated_by,
         updated_at = NOW()
       RETURNING *`,
      [
        String(flag_key).trim(),
        String(description || ''),
        toBool(enabled, false),
        rollout,
        String(segment || 'all'),
        String(updated_by || 'admin')
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'feature_flag_upserted',
        entityType: 'feature_flag',
        entityId: String(upsert.rows[0].id),
        payload: {
          flag_key: String(flag_key).trim(),
          enabled: toBool(enabled, false),
          rollout_pct: rollout
        }
      })
    } catch (_) {}
    res.json(upsert.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to save feature flag' })
  }
})

router.post('/feature-flags/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid flag id' })
    const result = await pool.query(
      `UPDATE admin_feature_flags
          SET enabled = NOT enabled,
              updated_at = NOW(),
              updated_by = $2
        WHERE id = $1
        RETURNING *`,
      [id, String(req.body?.updated_by || 'admin')]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Feature flag not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'feature_flag_toggled',
        entityType: 'feature_flag',
        entityId: String(id),
        payload: {
          flag_key: result.rows[0].flag_key,
          enabled: !!result.rows[0].enabled
        }
      })
    } catch (_) {}
    res.json(result.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle feature flag' })
  }
})

router.get('/notifications', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const status = req.query.status ? String(req.query.status) : null
    const params = []
    let where = ''
    if (status && status !== 'all') {
      params.push(status)
      where = `WHERE status = $1`
    }
    const result = await pool.query(
      `SELECT id, type, channel, title, message, audience, status, scheduled_for,
              sent_at, created_by, created_at
       FROM admin_notifications ${where} ORDER BY created_at DESC LIMIT 400`,
      params
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load notifications' })
  }
})

router.post('/notifications', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      type = 'info',
      channel = 'web',
      title = '',
      message,
      audience = 'all',
      scheduled_for = null,
      created_by = 'admin'
    } = req.body || {}
    if (!message || String(message).trim().length < 3) {
      return res.status(400).json({ error: 'message is required (min 3 chars)' })
    }
    const t = ['info', 'warning', 'success', 'error'].includes(String(type)) ? String(type) : 'info'
    const c = ['web', 'email', 'webhook'].includes(String(channel)) ? String(channel) : 'web'
    let scheduled = null
    if (scheduled_for) {
      const dt = new Date(scheduled_for)
      if (!Number.isNaN(dt.getTime())) scheduled = dt.toISOString()
    }
    const status = scheduled ? 'scheduled' : 'queued'
    const ins = await pool.query(
      `INSERT INTO admin_notifications
        (type, channel, title, message, audience, status, scheduled_for, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8)
       RETURNING *`,
      [t, c, String(title || ''), String(message).trim(), String(audience || 'all'), status, scheduled, String(created_by || 'admin')]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'notification_created',
        entityType: 'notification',
        entityId: String(ins.rows[0].id),
        payload: { type: t, channel: c, status }
      })
    } catch (_) {}
    res.status(201).json(ins.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create notification' })
  }
})

router.post('/notifications/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const status = String(req.body?.status || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid notification id' })
    if (!['queued', 'scheduled', 'sent', 'cancelled', 'read'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' })
    }
    const update = await pool.query(
      `UPDATE admin_notifications
          SET status = $2,
              sent_at = CASE WHEN $2 = 'sent' THEN NOW() ELSE sent_at END
        WHERE id = $1
        RETURNING *`,
      [id, status]
    )
    if (update.rows.length === 0) return res.status(404).json({ error: 'Notification not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'notification_status_updated',
        entityType: 'notification',
        entityId: String(id),
        payload: { status }
      })
    } catch (_) {}
    res.json(update.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update notification status' })
  }
})

router.get('/cases', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const status = req.query.status ? String(req.query.status) : null
    const owner = req.query.owner ? String(req.query.owner) : null
    const params = []
    const filters = []
    if (status && status !== 'all') {
      params.push(status)
      filters.push(`status = $${params.length}`)
    }
    if (owner && owner !== 'all') {
      params.push(owner)
      filters.push(`owner = $${params.length}`)
    }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : ''
    const result = await pool.query(
      `SELECT id, source_type, source_id, title, severity, priority, status,
              owner, notes, created_by, created_at, updated_at, closed_at
       FROM admin_cases ${where} ORDER BY created_at DESC LIMIT 500`,
      params
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load cases' })
  }
})

router.post('/cases', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      source_type = 'manual',
      source_id = '',
      title,
      severity = 'medium',
      priority = 'normal',
      owner = null,
      notes = '',
      created_by = 'admin'
    } = req.body || {}
    if (!title || String(title).trim().length < 3) {
      return res.status(400).json({ error: 'title is required (min 3 chars)' })
    }
    const sev = ['low', 'medium', 'high', 'critical'].includes(String(severity)) ? String(severity) : 'medium'
    const prio = ['low', 'normal', 'high', 'urgent'].includes(String(priority)) ? String(priority) : 'normal'
    const ins = await pool.query(
      `INSERT INTO admin_cases
        (source_type, source_id, title, severity, priority, owner, notes, created_by, status, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'open', NOW())
       RETURNING *`,
      [
        String(source_type || 'manual'),
        String(source_id || ''),
        String(title).trim(),
        sev,
        prio,
        owner ? String(owner) : null,
        String(notes || ''),
        String(created_by || 'admin')
      ]
    )
    try {
      await appendImmutableAudit(pool, {
        eventType: 'case_created',
        entityType: 'case',
        entityId: String(ins.rows[0].id),
        payload: { source_type: String(source_type || 'manual'), severity: sev, priority: prio }
      })
    } catch (_) {}
    res.status(201).json(ins.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to create case' })
  }
})

router.post('/cases/:id/assign', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const owner = String(req.body?.owner || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid case id' })
    if (!owner) return res.status(400).json({ error: 'owner is required' })
    const update = await pool.query(
      `UPDATE admin_cases
          SET owner = $2,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, owner]
    )
    if (update.rows.length === 0) return res.status(404).json({ error: 'Case not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'case_assigned',
        entityType: 'case',
        entityId: String(id),
        payload: { owner }
      })
    } catch (_) {}
    res.json(update.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to assign case owner' })
  }
})

router.post('/cases/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    const status = String(req.body?.status || '').trim()
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid case id' })
    const allowed = ['open', 'in_progress', 'pending_external', 'resolved', 'closed']
    if (!allowed.includes(status)) return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` })
    const update = await pool.query(
      `UPDATE admin_cases
          SET status = $2,
              closed_at = CASE WHEN $2 IN ('resolved', 'closed') THEN NOW() ELSE NULL END,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, status]
    )
    if (update.rows.length === 0) return res.status(404).json({ error: 'Case not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'case_status_updated',
        entityType: 'case',
        entityId: String(id),
        payload: { status }
      })
    } catch (_) {}
    res.json(update.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update case status' })
  }
})

router.get('/dispute-workflow', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    let rows = []
    try {
      const result = await pool.query(
        `SELECT
           d.id::text AS dispute_id,
           d.status,
           d.reason,
           d.description,
           d.admin_response,
           d.created_at,
           d.updated_at,
           u.full_name,
           u.email,
           u.trader_uid,
           a.account_uid,
           a.account_type,
           a.status AS account_status,
           COALESCE(m.owner, 'unassigned') AS owner,
           COALESCE(m.priority, 'normal') AS priority,
           COALESCE(m.sla_hours, 48)::int AS sla_hours,
           COALESCE(m.notes, '') AS notes
         FROM disputes d
         LEFT JOIN users u ON u.id::text = d.user_id::text
         LEFT JOIN accounts a ON a.id::text = d.account_id::text
         LEFT JOIN admin_dispute_meta m ON m.dispute_id = d.id::text
         ORDER BY d.created_at DESC
         LIMIT 500`
      )
      rows = result.rows.map(r => {
        const ageHours = r.created_at ? (Date.now() - new Date(r.created_at).getTime()) / 3600000 : 0
        const slaHours = Math.max(1, parseInt(r.sla_hours || 48, 10))
        const sla_status =
          ageHours >= slaHours * 1.75 ? 'breach'
            : ageHours >= slaHours ? 'overdue'
              : 'within_sla'
        return {
          ...r,
          age_hours: parseFloat(ageHours.toFixed(2)),
          sla_hours: slaHours,
          sla_status
        }
      })
    } catch (err) {
      if (err?.code !== '42P01') throw err
      rows = []
    }

    res.json({
      generated_at: new Date(),
      summary: {
        total: rows.length,
        open: rows.filter(r => r.status === 'open').length,
        under_review: rows.filter(r => r.status === 'under_review').length,
        resolved: rows.filter(r => r.status === 'resolved').length,
        rejected: rows.filter(r => r.status === 'rejected').length,
        overdue: rows.filter(r => r.sla_status === 'overdue' || r.sla_status === 'breach').length,
        breach: rows.filter(r => r.sla_status === 'breach').length
      },
      rows
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load dispute workflow' })
  }
})

router.post('/dispute-workflow/:id/meta', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const disputeId = String(req.params.id || '').trim()
    if (!disputeId) return res.status(400).json({ error: 'Invalid dispute id' })

    const owner = req.body?.owner ? String(req.body.owner).trim() : null
    const priorityRaw = req.body?.priority ? String(req.body.priority).trim().toLowerCase() : 'normal'
    const priority = ['low', 'normal', 'high', 'urgent'].includes(priorityRaw) ? priorityRaw : 'normal'
    const slaHours = Math.max(1, Math.min(336, parseInt(req.body?.sla_hours || 48, 10) || 48))
    const notes = String(req.body?.notes || '')

    const upsert = await pool.query(
      `INSERT INTO admin_dispute_meta (dispute_id, owner, priority, sla_hours, notes, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (dispute_id)
       DO UPDATE SET
         owner = EXCLUDED.owner,
         priority = EXCLUDED.priority,
         sla_hours = EXCLUDED.sla_hours,
         notes = EXCLUDED.notes,
         updated_at = NOW()
       RETURNING *`,
      [disputeId, owner, priority, slaHours, notes]
    )

    try {
      await appendImmutableAudit(pool, {
        eventType: 'dispute_meta_updated',
        entityType: 'dispute',
        entityId: disputeId,
        payload: { owner, priority, sla_hours: slaHours }
      })
    } catch (_) {}

    res.json(upsert.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to update dispute metadata' })
  }
})

router.post('/dispute-workflow/:id/status', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const disputeId = String(req.params.id || '').trim()
    if (!disputeId) return res.status(400).json({ error: 'Invalid dispute id' })
    const status = String(req.body?.status || '').trim()
    const adminResponse = String(req.body?.admin_response || '')
    const allowed = ['open', 'under_review', 'resolved', 'rejected']
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${allowed.join(', ')}` })
    }

    const result = await pool.query(
      `UPDATE disputes
          SET status = $2,
              admin_response = CASE WHEN $3 <> '' THEN $3 ELSE admin_response END,
              updated_at = NOW()
        WHERE id::text = $1
        RETURNING *`,
      [disputeId, status, adminResponse]
    )
    if (result.rows.length === 0) return res.status(404).json({ error: 'Dispute not found' })

    try {
      await appendImmutableAudit(pool, {
        eventType: 'dispute_status_updated',
        entityType: 'dispute',
        entityId: disputeId,
        payload: { status }
      })
    } catch (_) {}

    res.json(result.rows[0])
  } catch (err) {
    if (err?.code === '42P01') return res.status(404).json({ error: 'Disputes table not found' })
    res.status(500).json({ error: 'Failed to update dispute status' })
  }
})

router.post('/stress-simulator', authenticateAdmin, async (req, res) => {
  try {
    const shockPctRaw = parseFloat(req.body?.shock_pct ?? req.query.shock_pct ?? 2)
    const shockPct = Number.isFinite(shockPctRaw) ? Math.max(0.1, Math.min(25, shockPctRaw)) : 2
    const slippageRaw = parseFloat(req.body?.slippage_points ?? req.query.slippage_points ?? 0)
    const slippagePoints = Number.isFinite(slippageRaw) ? Math.max(0, Math.min(500, slippageRaw)) : 0
    const instrument = String(req.body?.instrument || req.query.instrument || '').trim().toUpperCase()

    const query = await pool.query(
      `SELECT
         t.id::text AS trade_id,
         t.account_id::text AS account_id,
         COALESCE(a.account_uid::text, a.id::text) AS account_uid,
         a.account_type,
         a.status AS account_status,
         COALESCE(u.full_name, '') AS full_name,
         COALESCE(u.email, '') AS email,
         t.instrument,
         t.direction,
         COALESCE(t.open_price, 0)::numeric AS open_price,
         COALESCE(t.lot_size, 0)::numeric AS lot_size,
         COALESCE(p.bid, t.open_price)::numeric AS bid,
         COALESCE(p.ask, t.open_price)::numeric AS ask
       FROM trades t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN users u ON u.id = a.user_id
       LEFT JOIN price_feed p ON p.instrument = t.instrument
       WHERE t.status = 'open'
         AND ($1 = '' OR t.instrument = $1)
       ORDER BY t.open_time DESC
       LIMIT 5000`,
      [instrument]
    )

    const byAccount = new Map()
    const tradeRows = []

    for (const row of query.rows) {
      const openPrice = parseFloat(row.open_price || 0)
      const lots = parseFloat(row.lot_size || 0)
      const currentPrice = String(row.direction) === 'buy'
        ? parseFloat(row.bid || openPrice)
        : parseFloat(row.ask || openPrice)

      const pointSize = ['XAUUSD', 'XAGUSD'].includes(String(row.instrument)) ? 0.01 : 0.0001
      const shockMove = currentPrice * (shockPct / 100)
      const slippageMove = slippagePoints * pointSize
      const stressedPrice = String(row.direction) === 'buy'
        ? Math.max(0, currentPrice - shockMove - slippageMove)
        : Math.max(0, currentPrice + shockMove + slippageMove)

      const currentPnl = calcTradePnl(String(row.direction), openPrice, currentPrice, lots, String(row.instrument))
      const stressedPnl = calcTradePnl(String(row.direction), openPrice, stressedPrice, lots, String(row.instrument))
      const pnlDelta = parseFloat((stressedPnl - currentPnl).toFixed(2))

      tradeRows.push({
        trade_id: row.trade_id,
        account_id: row.account_id,
        account_uid: row.account_uid,
        account_type: row.account_type,
        full_name: row.full_name,
        email: row.email,
        instrument: row.instrument,
        direction: row.direction,
        lot_size: lots,
        current_price: parseFloat(currentPrice.toFixed(5)),
        stressed_price: parseFloat(stressedPrice.toFixed(5)),
        current_pnl: currentPnl,
        stressed_pnl: stressedPnl,
        pnl_delta: pnlDelta
      })

      const agg = byAccount.get(row.account_id) || {
        account_id: row.account_id,
        account_uid: row.account_uid,
        account_type: row.account_type,
        full_name: row.full_name,
        email: row.email,
        trade_count: 0,
        current_pnl: 0,
        stressed_pnl: 0,
        pnl_delta: 0
      }
      agg.trade_count += 1
      agg.current_pnl += currentPnl
      agg.stressed_pnl += stressedPnl
      agg.pnl_delta += pnlDelta
      byAccount.set(row.account_id, agg)
    }

    const accounts = Array.from(byAccount.values()).map(a => ({
      ...a,
      current_pnl: parseFloat(a.current_pnl.toFixed(2)),
      stressed_pnl: parseFloat(a.stressed_pnl.toFixed(2)),
      pnl_delta: parseFloat(a.pnl_delta.toFixed(2))
    })).sort((a, b) => a.pnl_delta - b.pnl_delta)

    const totalCurrent = tradeRows.reduce((s, t) => s + (t.current_pnl || 0), 0)
    const totalStressed = tradeRows.reduce((s, t) => s + (t.stressed_pnl || 0), 0)
    const totalDelta = totalStressed - totalCurrent

    res.json({
      generated_at: new Date(),
      params: {
        shock_pct: shockPct,
        slippage_points: slippagePoints,
        instrument: instrument || 'all'
      },
      summary: {
        open_trades: tradeRows.length,
        affected_accounts: accounts.length,
        current_total_pnl: parseFloat(totalCurrent.toFixed(2)),
        stressed_total_pnl: parseFloat(totalStressed.toFixed(2)),
        pnl_delta: parseFloat(totalDelta.toFixed(2))
      },
      by_account: accounts.slice(0, 300),
      top_trade_impacts: [...tradeRows]
        .sort((a, b) => a.pnl_delta - b.pnl_delta)
        .slice(0, 300)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to run stress simulation' })
  }
})

router.get('/scheduled-reports', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const result = await pool.query(
      `SELECT
         id, report_key, title, channel, recipients, schedule_cron, timezone,
         enabled, last_run_at, next_run_at, created_by, created_at, updated_at
       FROM admin_scheduled_reports
       ORDER BY enabled DESC, updated_at DESC, id DESC
       LIMIT 500`
    )
    res.json(result.rows)
  } catch (err) {
    res.status(500).json({ error: 'Failed to load scheduled reports' })
  }
})

router.post('/scheduled-reports', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const {
      id = null,
      report_key,
      title,
      channel = 'email',
      recipients = '',
      schedule_cron = '0 9 * * *',
      timezone = 'UTC',
      enabled = true,
      next_run_at = null,
      created_by = 'admin'
    } = req.body || {}

    if (!report_key || String(report_key).trim().length < 2) {
      return res.status(400).json({ error: 'report_key is required (min 2 chars)' })
    }
    if (!title || String(title).trim().length < 3) {
      return res.status(400).json({ error: 'title is required (min 3 chars)' })
    }
    const safeChannel = ['email', 'web', 'webhook'].includes(String(channel)) ? String(channel) : 'email'
    const nextRun = next_run_at ? new Date(next_run_at) : null
    const parsedNextRun = nextRun && !Number.isNaN(nextRun.getTime()) ? nextRun.toISOString() : null

    const normalizedRecipients = Array.isArray(recipients)
      ? recipients.map(v => String(v || '').trim()).filter(Boolean).join(',')
      : String(recipients || '').trim()

    let saved
    if (id && Number.isFinite(parseInt(id, 10))) {
      const update = await pool.query(
        `UPDATE admin_scheduled_reports
            SET report_key = $2,
                title = $3,
                channel = $4,
                recipients = $5,
                schedule_cron = $6,
                timezone = $7,
                enabled = $8,
                next_run_at = $9::timestamptz,
                updated_at = NOW()
          WHERE id = $1
          RETURNING *`,
        [
          parseInt(id, 10),
          String(report_key).trim(),
          String(title).trim(),
          safeChannel,
          normalizedRecipients,
          String(schedule_cron || '0 9 * * *').trim(),
          String(timezone || 'UTC').trim(),
          toBool(enabled, true),
          parsedNextRun
        ]
      )
      if (update.rows.length === 0) return res.status(404).json({ error: 'Scheduled report not found' })
      saved = update.rows[0]
    } else {
      const insert = await pool.query(
        `INSERT INTO admin_scheduled_reports
          (report_key, title, channel, recipients, schedule_cron, timezone, enabled, next_run_at, created_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, NOW())
         RETURNING *`,
        [
          String(report_key).trim(),
          String(title).trim(),
          safeChannel,
          normalizedRecipients,
          String(schedule_cron || '0 9 * * *').trim(),
          String(timezone || 'UTC').trim(),
          toBool(enabled, true),
          parsedNextRun,
          String(created_by || 'admin').trim()
        ]
      )
      saved = insert.rows[0]
    }

    try {
      await appendImmutableAudit(pool, {
        eventType: 'scheduled_report_saved',
        entityType: 'scheduled_report',
        entityId: String(saved.id),
        payload: {
          report_key: saved.report_key,
          enabled: !!saved.enabled,
          channel: saved.channel
        }
      })
    } catch (_) {}

    res.json(saved)
  } catch (err) {
    res.status(500).json({ error: 'Failed to save scheduled report' })
  }
})

router.post('/scheduled-reports/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    await ensureFeatureTables()
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid report id' })
    const updated = await pool.query(
      `UPDATE admin_scheduled_reports
          SET enabled = NOT enabled,
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id]
    )
    if (updated.rows.length === 0) return res.status(404).json({ error: 'Scheduled report not found' })
    try {
      await appendImmutableAudit(pool, {
        eventType: 'scheduled_report_toggled',
        entityType: 'scheduled_report',
        entityId: String(id),
        payload: { enabled: !!updated.rows[0].enabled }
      })
    } catch (_) {}
    res.json(updated.rows[0])
  } catch (err) {
    res.status(500).json({ error: 'Failed to toggle scheduled report' })
  }
})

router.get('/emergency-kill/status', authenticateAdmin, async (req, res) => {
  try {
    const settings = await getSettingsMap([
      'emergency_kill_enabled',
      'emergency_kill_last_triggered_at',
      'emergency_kill_last_reset_at',
      'copier_enabled'
    ])
    const openTrades = await pool.query(`SELECT COUNT(*)::int AS c FROM trades WHERE status = 'open'`)
    res.json({
      enabled: toBool(settings.emergency_kill_enabled, false),
      last_triggered_at: settings.emergency_kill_last_triggered_at || null,
      last_reset_at: settings.emergency_kill_last_reset_at || null,
      copier_enabled: toBool(settings.copier_enabled, true),
      open_trades: parseInt(openTrades.rows[0]?.c || 0, 10)
    })
  } catch (err) {
    res.status(500).json({ error: 'Failed to load emergency kill status' })
  }
})

router.post('/emergency-kill/execute', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const dryRun = toBool(req.body?.dry_run, false)
    const confirmPhrase = String(req.body?.confirm_phrase || '').trim()
    if (!dryRun && confirmPhrase !== 'KILL ALL TRADES') {
      return res.status(400).json({ error: 'confirm_phrase must be exactly "KILL ALL TRADES"' })
    }

    const preview = await pool.query(
      `SELECT account_id::text AS account_id, COUNT(*)::int AS open_trades
       FROM trades
       WHERE status = 'open'
       GROUP BY account_id
       ORDER BY COUNT(*) DESC`
    )
    const openTradeCount = preview.rows.reduce((sum, r) => sum + parseInt(r.open_trades || 0, 10), 0)
    if (dryRun) {
      return res.json({
        dry_run: true,
        open_trades: openTradeCount,
        affected_accounts: preview.rows.length,
        by_account: preview.rows
      })
    }

    await client.query('BEGIN')
    const accountIdsResult = await client.query(
      `SELECT DISTINCT account_id::text AS account_id FROM trades WHERE status = 'open'`
    )

    let closedTrades = 0
    let totalPnl = 0
    for (const row of accountIdsResult.rows) {
      const closeResult = await forceCloseOpenTradesForAccount(client, row.account_id)
      closedTrades += closeResult.closedCount
      totalPnl += closeResult.totalPnl
    }

    await upsertSetting(client, 'emergency_kill_enabled', 'true')
    await upsertSetting(client, 'emergency_kill_last_triggered_at', new Date().toISOString())
    await upsertSetting(client, 'copier_enabled', 'false')

    try {
      await appendImmutableAudit(client, {
        eventType: 'emergency_kill_executed',
        entityType: 'system',
        entityId: 'global',
        payload: {
          closed_trades: closedTrades,
          affected_accounts: accountIdsResult.rows.length,
          total_pnl: parseFloat(totalPnl.toFixed(2))
        }
      })
    } catch (_) {}

    await client.query('COMMIT')
    res.json({
      dry_run: false,
      closed_trades: closedTrades,
      affected_accounts: accountIdsResult.rows.length,
      total_pnl: parseFloat(totalPnl.toFixed(2)),
      copier_enabled: false,
      emergency_kill_enabled: true
    })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to execute emergency kill switch' })
  } finally {
    client.release()
  }
})

router.post('/emergency-kill/reset', authenticateAdmin, async (req, res) => {
  const client = await pool.connect()
  try {
    await ensureFeatureTables()
    const reEnableCopier = toBool(req.body?.reenable_copier, false)

    await client.query('BEGIN')
    await upsertSetting(client, 'emergency_kill_enabled', 'false')
    await upsertSetting(client, 'emergency_kill_last_reset_at', new Date().toISOString())
    if (reEnableCopier) {
      await upsertSetting(client, 'copier_enabled', 'true')
    }

    try {
      await appendImmutableAudit(client, {
        eventType: 'emergency_kill_reset',
        entityType: 'system',
        entityId: 'global',
        payload: { reenable_copier: reEnableCopier }
      })
    } catch (_) {}

    await client.query('COMMIT')
    res.json({
      emergency_kill_enabled: false,
      copier_enabled: reEnableCopier ? true : undefined,
      last_reset_at: new Date().toISOString()
    })
  } catch (err) {
    await client.query('ROLLBACK')
    res.status(500).json({ error: 'Failed to reset emergency kill switch' })
  } finally {
    client.release()
  }
})

// ── KYC Document Viewer ───────────────────────────────────────────────────────
router.get('/kyc/document/:userId/:type', authenticateAdmin, async (req, res) => {
  try {
    const { userId, type } = req.params;
    const documentType = type === 'id' ? 'id_document' : 'selfie_document';
    
    const userKyc = await pool.query(
      `SELECT * FROM user_kyc WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    
    if (userKyc.rows.length === 0 || !userKyc.rows[0][documentType]) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    // Send the file
    const path = require('path');
    const fs = require('fs');
    
    // In kyc.js, files were saved to "uploads/kyc/...". 
    // We expect the DB column to contain "/uploads/kyc/filename.ext".
    const docUrl = userKyc.rows[0][documentType];
    // Strip the leading "/uploads/" which is mapped to the standard uploads directory
    const relPath = docUrl.replace(/^\/?uploads\//, '');
    
    const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
    const absoluteFilePath = path.resolve(uploadsRoot, relPath);

    // FIX: Path traversal guard — reject any resolved path that escapes the
    // uploads directory. A malicious DB value like "../../etc/passwd" resolves
    // outside uploadsRoot and is blocked before fs.existsSync is reached.
    if (!absoluteFilePath.startsWith(uploadsRoot + path.sep)) {
      logger.warn('[kyc-doc] Path traversal attempt blocked:', { docUrl, userId: req.params.userId });
      return res.status(400).json({ error: 'Invalid document path' });
    }
    
    if (!fs.existsSync(absoluteFilePath)) {
      return res.status(404).json({ error: 'File physically missing from server disk' });
    }
    
    res.sendFile(absoluteFilePath);
  } catch (err) {
    if (err.code === '42P01') return res.status(404).json({ error: 'user_kyc table not found' });
    res.status(500).json({ error: 'Failed to retrieve KYC document' });
  }
});

module.exports = router;
