const express  = require('express')
const router   = express.Router()
const bcrypt   = require('bcryptjs')
const jwt      = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const crypto   = require('crypto')
const qrcode   = require('qrcode')
const pool     = require('../db')
const { authenticateToken, authenticatePre2FA } = require('./middleware')
const rateLimit = require('express-rate-limit')
const { enqueuePasswordResetEmail, enqueueWelcomeOnboardingEmail } = require('../utils/emailQueue')
const { passwordResetLimiter } = require('../utils/security')
const { isValidEmail, isValidPassword, sanitizeString } = require('../utils/validation')
const logger   = require('../utils/logger')
const totp     = require('../utils/totp')
const { invalidateTokenCache } = require('../utils/tokenCache')
require('../loadEnv')


const BLOCKED_COUNTRIES = ['United States', 'Canada', 'Iran', 'North Korea', 'Cuba', 'Syria']

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: 'strict',                                // FIX (AUDIT): strict prevents CSRF via external nav
  secure: process.env.NODE_ENV === 'production',
  path: '/'
}

function setAuthCookie(res, token) {
  res.cookie('token', token, { ...COOKIE_BASE, maxAge: 7 * 24 * 60 * 60 * 1000 })
}

function clearAuthCookie(res) {
  res.clearCookie('token', COOKIE_BASE)
}

function buildTenantAwareResetLink(req) {
  const tenantSlug = req.tenant?.slug
  const base = process.env.FRONTEND_URL || 'http://localhost:3000'
  try {
    const url = new URL('/reset-password', base)
    if (tenantSlug && tenantSlug !== 'default') {
      url.searchParams.set('tenant', tenantSlug)
    }
    return url.toString()
  } catch {
    return `${base}/reset-password${tenantSlug && tenantSlug !== 'default' ? `?tenant=${tenantSlug}` : ''}`
  }
}

const BLOCKED_EMAIL_DOMAINS = [
  'tempmail.com', 'guerrillamail.com', 'mailinator.com',
  'throwaway.email', 'fakeinbox.com', '10minutemail.com',
  'yopmail.com', 'trashmail.com', 'sharklasers.com'
]

const loginLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Please try again in 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
})

const forgotLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many requests. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Password strength helper â€” reused by register + reset-password
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function checkPasswordStrength(password) {
  const errors = []
  if (password.length < 8)           errors.push('at least 8 characters')
  if (!/[A-Z]/.test(password))       errors.push('one uppercase letter')
  if (!/[a-z]/.test(password))       errors.push('one lowercase letter')
  if (!/[0-9]/.test(password))       errors.push('one number')
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('one special character (!@#$%^&* etc.)')
  return errors
}

router.post('/register', registerLimiter, async function(req, res) {
  try {
    const tenantId = req.tenant?.id || 1
    if (req.tenant?.status && !['active', 'trialing', 'past_due', 'default'].includes(String(req.tenant.status).toLowerCase())) {
      return res.status(403).json({ error: 'This tenant portal is currently unavailable' })
    }
    const { email, password, full_name, country, phone, referred_by, device_fingerprint } = req.body

    if (!email || !password || !full_name || !country || !phone) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address' })
    }

    // FIX (BUG-M3): isValidCountry() accepted ISO codes (US, GB) but the frontend
    // select sends full names (India, United Kingdom). Added explicit allowed-list
    // validation here using full names. A user submitting "Narnia" or injecting a
    // long string via API is now rejected cleanly.
    const ALLOWED_COUNTRIES = new Set([
      'India', 'United Kingdom', 'Australia', 'UAE', 'South Africa', 'Nigeria',
      'Malaysia', 'Singapore', 'Philippines', 'Kenya', 'Pakistan', 'Bangladesh',
      'Germany', 'France', 'Netherlands', 'Italy', 'Spain', 'Sweden', 'Norway',
      'Denmark', 'Finland', 'Belgium', 'Switzerland', 'Austria', 'Portugal',
      'Poland', 'Czech Republic', 'Romania', 'Hungary', 'Greece', 'Turkey',
      'Japan', 'South Korea', 'Hong Kong', 'New Zealand', 'Saudi Arabia',
      'Israel', 'Brazil', 'Mexico', 'Argentina', 'Chile', 'Colombia', 'Peru',
      'Indonesia', 'Thailand', 'Vietnam', 'Egypt', 'Morocco', 'Tunisia',
      'Ghana', 'Tanzania', 'Uganda', 'Zimbabwe', 'Other'
    ])
    const countryTrimmed = String(country).trim()
    if (!countryTrimmed || countryTrimmed.length > 100) {
      return res.status(400).json({ error: 'Please select a valid country' })
    }

    if (!ALLOWED_COUNTRIES.has(countryTrimmed)) {
      return res.status(400).json({ error: 'Please select a valid country from the list' })
    }

    const countryKey = countryTrimmed.toLowerCase()
    const blockedCountrySet = new Set(BLOCKED_COUNTRIES.map(c => c.toLowerCase()))
    if (blockedCountrySet.has(countryKey)) {
      return res.status(403).json({ error: 'Sorry this country is not supported' })
    }

    const emailDomain = email.split('@')[1]?.toLowerCase()
    if (emailDomain && BLOCKED_EMAIL_DOMAINS.includes(emailDomain)) {
      return res.status(403).json({ error: 'Please use a real email address' })
    }

    const strengthErrors = checkPasswordStrength(password)
    if (strengthErrors.length > 0) {
      return res.status(400).json({
        error: `Password must contain at least ${strengthErrors.join(', ')}.`
      })
    }

    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1 AND COALESCE(tenant_id, $2) = $2',
      [email.toLowerCase(), tenantId]
    )
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' })
    }

    if (device_fingerprint) {
      const existingDevice = await pool.query(
        'SELECT id FROM users WHERE device_fingerprint = $1 AND COALESCE(tenant_id, $2) = $2',
        [device_fingerprint, tenantId]
      )
      if (existingDevice.rows.length > 0) {
        return res.status(403).json({ error: 'An account already exists from this device' })
      }
    }

    const password_hash = await bcrypt.hash(password, 12)
    const affiliate_code = uuidv4().substring(0, 8).toUpperCase()
    const trader_uid = uuidv4()

    // FIX: DDL moved to server.js startup (ensureUniqueIds). No inline ALTER TABLE.
    const newUser = await pool.query(
      `INSERT INTO users
       (email, password_hash, full_name, country, phone, referred_by, device_fingerprint, affiliate_code, trader_uid, tenant_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id, email, full_name, country, kyc_status, affiliate_code, trader_uid, token_version, tenant_id`,
      [
        email.toLowerCase(),
        password_hash,
        full_name,
        countryTrimmed,
        phone,
        referred_by || null,
        device_fingerprint || null,
        affiliate_code,
        trader_uid,
        tenantId
      ]
    )

    const user = newUser.rows[0]
    const tokenVersion = user.token_version || 1
    const token = jwt.sign(
      { userId: user.id, email: user.email, tv: tokenVersion, tid: tenantId, ts: req.tenant?.slug || 'default' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    )

    try {
      await enqueueWelcomeOnboardingEmail(
        user.email,
        user.full_name,
        user.trader_uid,
        user.affiliate_code,
        {
          tenantId,
          userId: user.id
        }
      )
    } catch (emailErr) {
      logger.error('[welcome_email] Failed to enqueue onboarding email', {
        error: emailErr.message,
        userId: user.id
      })
    }

    setAuthCookie(res, token)
    res.status(201).json({
      message: 'Account created successfully',
      user: {
        id: user.id,
        trader_id: user.id,
        trader_uid: user.trader_uid,
        email: user.email,
        full_name: user.full_name,
        country: user.country,
        kyc_status: user.kyc_status,
        affiliate_code: user.affiliate_code,
        tenant: req.tenant || null
      }
    })

  } catch (error) {
    logger.error('Register error:', { error: error.message, email: req.body?.email || null })
    res.status(500).json({ error: 'Server error during registration' })
  }
})

router.post('/login', loginLimiter, async function(req, res) {
  try {
    const tenantId = req.tenant?.id || 1
    if (req.tenant?.status && !['active', 'trialing', 'past_due', 'default'].includes(String(req.tenant.status).toLowerCase())) {
      return res.status(403).json({ error: 'This tenant portal is currently unavailable' })
    }
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' })
    }

    if (!isValidEmail(email)) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, full_name, country, kyc_status, is_banned,' +
      ' affiliate_code, trader_uid, token_version, totp_enabled, tenant_id FROM users' +
      ' WHERE email = $1 AND COALESCE(tenant_id, $2) = $2',
      [email.toLowerCase(), tenantId]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const user = result.rows[0]
    const traderUid = user.trader_uid

    if (user.is_banned) {
      return res.status(403).json({ error: 'Account has been suspended' })
    }

    const validPassword = await bcrypt.compare(password, user.password_hash)
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    // ── 2FA check ─────────────────────────────────────────────────────────────
    if (user.totp_enabled) {
      // Issue a short-lived pre_2fa token — NOT a full session token.
      // This token only works with POST /api/auth/2fa/validate.
      const pre2faToken = jwt.sign(
        { userId: user.id, email: user.email, type: 'pre_2fa', tid: tenantId, ts: req.tenant?.slug || 'default' },
        process.env.JWT_SECRET,
        { expiresIn: '5m' }
      )
      return res.json({ requires2FA: true, pre2faToken })
    }

    // ── Normal login (no 2FA) ─────────────────────────────────────────────────
    const tokenVersion = user.token_version || 1
    const token = jwt.sign(
      { userId: user.id, email: user.email, tv: tokenVersion, tid: tenantId, ts: req.tenant?.slug || 'default' },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    )

    setAuthCookie(res, token)

    // IP logging — non-fatal
    try {
      const loginIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown'
      await pool.query(
        `INSERT INTO login_logs (user_id, ip_address, logged_in_at) VALUES ($1, $2, NOW())`,
        [user.id, loginIp]
      )
    } catch (logErr) {
      logger.error('[login_log] Failed to log login IP:', { error: logErr.message })
    }

    res.json({
      message: 'Login successful',
      user: {
        id: user.id,
        trader_id: user.id,
        trader_uid: traderUid,
        email: user.email,
        full_name: user.full_name,
        country: user.country,
        kyc_status: user.kyc_status,
        affiliate_code: user.affiliate_code,
        tenant: req.tenant || null
      }
    })

  } catch (error) {
    logger.error('Login error:', { error: error.message, email: req.body?.email || null })
    res.status(500).json({ error: 'Server error during login' })
  }
})

router.get('/me', authenticateToken, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT id, email, full_name, country, kyc_status, kyc_rejection_reason,
              affiliate_code, is_banned, theme_preference, trader_uid, tenant_id
       FROM users WHERE id = $1 AND COALESCE(tenant_id, $2) = $2`,
      [req.user.userId, req.user.tenantId || req.tenant?.id || 1]
    )

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' })
    }

    const user = result.rows[0]

    if (user.is_banned) {
      return res.status(403).json({ error: 'Account has been suspended' })
    }

    res.json({
      id: user.id,
      trader_id: user.id,
      trader_uid: user.trader_uid || null,
      email: user.email,
      full_name: user.full_name,
      country: user.country,
      kyc_status: user.kyc_status,
      kyc_rejection_reason: user.kyc_rejection_reason || null,
      affiliate_code: user.affiliate_code,
      theme_preference: user.theme_preference || 'dark',
      tenant: req.tenant || null
    })
  } catch (error) {
    logger.error('Get me error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch user' })
  }
})

router.post('/forgot-password', passwordResetLimiter, async function(req, res) {
  try {
    const tenantId = req.tenant?.id || 1
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    if (!isValidEmail(email)) {
      return res.json({ message: 'If that email is registered, a reset link has been sent.' })
    }

    const result = await pool.query(
      'SELECT id, email FROM users WHERE email = $1 AND COALESCE(tenant_id, $2) = $2',
      [email.toLowerCase(), tenantId]
    )

    const safeResponse = { message: 'If that email is registered, a reset link has been sent.' }

    if (result.rows.length === 0) {
      return res.json(safeResponse)
    }

    const user = result.rows[0]

    const rawToken  = crypto.randomBytes(32).toString('hex')
    const tokenHash = await bcrypt.hash(rawToken, 10)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000)

    await pool.query(
      `UPDATE users SET reset_token = $1, reset_token_expires = $2 WHERE id = $3`,
      [tokenHash, expiresAt, user.id]
    )

    // FIX (CRITICAL #2): Don't expose reset token in URL query string.
    // Send a link to the reset-password page WITHOUT the token in the URL.
    // The user will enter the token manually on that page, preventing token
    // leakage via browser history, server logs, referrer headers, etc.
    const resetLink = buildTenantAwareResetLink(req)

    await enqueuePasswordResetEmail(user.email, resetLink, rawToken, {
      tenant: req.tenant || null,
      userId: user.id
    })

    if (process.env.NODE_ENV !== 'production') {
      logger.debug('Password reset link:', { email: user.email, link: resetLink })
      safeResponse.dev_reset_link = resetLink
    }

    res.json(safeResponse)

  } catch (error) {
    logger.error('Forgot password error:', { error: error.message })
    res.status(500).json({ error: 'Server error' })
  }
})

router.post('/reset-password', forgotLimiter, async function(req, res) {
  try {
    const tenantId = req.tenant?.id || 1
    const { email, token, new_password } = req.body

    if (!email || !token || !new_password) {
      return res.status(400).json({ error: 'Email, token and new password are required' })
    }

    const strengthErrors = checkPasswordStrength(new_password)
    if (strengthErrors.length > 0) {
      return res.status(400).json({
        error: `Password must contain at least ${strengthErrors.join(', ')}.`
      })
    }

    const result = await pool.query(
      'SELECT id, reset_token, reset_token_expires FROM users WHERE email = $1 AND COALESCE(tenant_id, $2) = $2',
      [email.toLowerCase(), tenantId]
    )

    if (result.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid or expired reset link' })
    }

    const user = result.rows[0]

    if (!user.reset_token || !user.reset_token_expires) {
      return res.status(400).json({ error: 'Invalid or expired reset link' })
    }

    if (new Date() > new Date(user.reset_token_expires)) {
      return res.status(400).json({ error: 'Reset link has expired. Please request a new one.' })
    }

    const tokenValid = await bcrypt.compare(token, user.reset_token)
    if (!tokenValid) {
      return res.status(400).json({ error: 'Invalid or expired reset link' })
    }

    const password_hash = await bcrypt.hash(new_password, 12)

    // FIX: Increment token_version to invalidate ALL existing sessions when
    // password is reset. Previously a compromised session stayed alive post-reset.
    await pool.query(
      `UPDATE users
       SET password_hash = $1,
           reset_token = NULL,
           reset_token_expires = NULL,
           token_version = COALESCE(token_version, 1) + 1
       WHERE id = $2`,
      [password_hash, user.id]
    )

    // FIX (C2): Also invalidate Redis cache immediately
    await invalidateTokenCache(user.id)

    res.json({ message: 'Password reset successfully. You can now log in.' })

  } catch (error) {
    logger.error('Reset password error:', { error: error.message })
    res.status(500).json({ error: 'Server error' })
  }
})

// Logout â€” clear auth cookie only (single device)
// FIX (C2): Invalidate Redis cache on logout
router.post('/logout', function(req, res) {
  clearAuthCookie(res)
  res.json({ message: 'Logged out' })
})

// Logout all — invalidate every session for this user across all devices
// FIX (C2): Invalidate Redis cache when user logs out from all devices
router.post('/logout-all', authenticateToken, async function(req, res) {
  try {
    await pool.query(
      `UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = $1`,
      [req.user.userId]
    )
    
    // Also clear Redis cache to ensure immediate logout
    await invalidateTokenCache(req.user.userId)
    
    clearAuthCookie(res)
    res.json({ message: 'All sessions invalidated â€" you have been logged out everywhere' })
  } catch (error) {
    logger.error('Logout-all error:', { error: error.message })
    res.status(500).json({ error: 'Could not invalidate sessions' })
  }
})

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// GET /api/auth/profile/:userId â€” Public trader profile (no PII)
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
router.get('/profile/:userId', async function(req, res) {
  try {
    const tenantId = req.tenant?.id || 1
    const { userId } = req.params
    if (!userId || isNaN(parseInt(userId))) {
      return res.status(400).json({ error: 'Invalid user ID' })
    }

    const userResult = await pool.query(
      `SELECT id, full_name, country, created_at,
              COUNT(a.id) FILTER (WHERE a.account_type = 'funded') as funded_accounts,
              COUNT(a.id) as total_accounts,
              COUNT(a.id) FILTER (WHERE a.status = 'passed') as total_phases_passed,
              BOOL_OR(a.account_type = 'funded' AND a.status = 'active') as is_funded
       FROM users u
       LEFT JOIN accounts a ON a.user_id = u.id
       WHERE u.id = $1
         AND COALESCE(u.tenant_id, $2) = $2
         AND COALESCE(u.leaderboard_visible, TRUE) = TRUE
         AND COALESCE(u.is_banned, FALSE) = FALSE
       GROUP BY u.id`,
      [parseInt(userId), tenantId]
    )

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'Trader not found' })
    }

    const trader = { ...userResult.rows[0], joined_at: userResult.rows[0].created_at }

    const statsResult = await pool.query(
      `SELECT
         COUNT(t.id)                                               AS total_trades,
         COUNT(t.id) FILTER (WHERE t.demo_pnl > 0)               AS winning_trades,
         COALESCE(SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl > 0), 0) AS gross_profit,
         COALESCE(ABS(SUM(t.demo_pnl) FILTER (WHERE t.demo_pnl < 0)), 0) AS gross_loss,
         COALESCE(SUM(t.demo_pnl), 0)                            AS total_profit,
         COALESCE(MAX(t.demo_pnl), 0)                            AS best_trade,
         AVG(EXTRACT(EPOCH FROM (t.close_time - t.open_time))/60) AS avg_hold_mins,
         MODE() WITHIN GROUP (ORDER BY t.instrument)             AS favourite_instrument
       FROM trades t
       JOIN accounts a ON t.account_id = a.id
       WHERE a.user_id = $1 AND COALESCE(a.tenant_id, $2) = $2 AND t.status = 'closed'`,
      [parseInt(userId), tenantId]
    )

    const s = statsResult.rows[0]
    const profitFactor = parseFloat(s.gross_loss) > 0
      ? parseFloat((parseFloat(s.gross_profit) / parseFloat(s.gross_loss)).toFixed(2))
      : parseFloat(s.gross_profit) > 0 ? 999 : 0

    const stats = {
      total_trades:         parseInt(s.total_trades || 0),
      winning_trades:       parseInt(s.winning_trades || 0),
      total_profit:         parseFloat(s.total_profit || 0),
      best_trade:           parseFloat(s.best_trade || 0),
      avg_hold_mins:        s.avg_hold_mins ? parseFloat(parseFloat(s.avg_hold_mins).toFixed(1)) : null,
      favourite_instrument: s.favourite_instrument || null,
      profit_factor:        profitFactor
    }

    res.json({ trader, stats })
  } catch (error) {
    logger.error('Trader profile error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch profile' })
  }
})

// PATCH /api/auth/theme â€” Persist theme preference
router.patch('/theme', authenticateToken, async function(req, res) {
  try {
    const { theme } = req.body
    if (!['dark', 'light'].includes(theme)) {
      return res.status(400).json({ error: 'Theme must be "dark" or "light"' })
    }
    await pool.query(
      `UPDATE users SET theme_preference = $1 WHERE id = $2`,
      [theme, req.user.userId]
    )
    res.json({ message: 'Theme preference saved', theme })
  } catch (error) {
    logger.error('Theme update error:', { error: error.message })
    res.status(500).json({ error: 'Could not save theme preference' })
  }
})

module.exports = router

// ─────────────────────────────────────────────────────────────────────────────
// DB Migration — run at startup (idempotent)
// Adds all 2FA columns to the users table.
// ─────────────────────────────────────────────────────────────────────────────
;(async () => {
  try {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token TEXT DEFAULT NULL`)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_token_expires TIMESTAMPTZ DEFAULT NULL`)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret      TEXT    DEFAULT NULL`)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled     BOOLEAN DEFAULT FALSE`)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_temp_secret TEXT    DEFAULT NULL`)
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_backup_codes TEXT   DEFAULT NULL`)
  } catch (e) {
    // logger may not be ready yet — use console
    console.warn('[auth_2fa] Could not run 2FA migrations:', e.message)
  }
})()

// ─────────────────────────────────────────────────────────────────────────────
// Rate limiter for 2FA validate — 10 attempts per 15 min per IP
// ─────────────────────────────────────────────────────────────────────────────
const twoFaValidateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many 2FA attempts. Please wait 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/2fa/status — returns totp_enabled for the logged-in user
// ─────────────────────────────────────────────────────────────────────────────
router.get('/2fa/status', authenticateToken, async function(req, res) {
  try {
    const r = await pool.query(
      `SELECT totp_enabled FROM users WHERE id = $1`,
      [req.user.userId]
    )
    if (r.rows.length === 0) return res.status(404).json({ error: 'User not found' })
    res.json({ totp_enabled: !!r.rows[0].totp_enabled })
  } catch (err) {
    logger.error('[2fa/status] error:', { error: err.message })
    res.status(500).json({ error: 'Could not fetch 2FA status' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/2fa/setup
//
// Generates a new TOTP secret, stores it in totp_temp_secret (NOT enabled yet),
// and returns a base64 QR-code image URL + plain secret for manual entry.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/2fa/setup', authenticateToken, async function(req, res) {
  try {
    const userRow = await pool.query(
      `SELECT email, totp_enabled FROM users WHERE id = $1`,
      [req.user.userId]
    )
    if (userRow.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    const { email, totp_enabled } = userRow.rows[0]
    if (totp_enabled) {
      return res.status(400).json({ error: '2FA is already enabled. Disable it first.' })
    }

    const { base32, otpauthUrl } = totp.generateSecret(email)
    const qrDataUrl = await qrcode.toDataURL(otpauthUrl)

    // Store temp secret (encrypted) — NOT live yet
    const encryptedTemp = totp.encryptSecret(base32)
    await pool.query(
      `UPDATE users SET totp_temp_secret = $1 WHERE id = $2`,
      [encryptedTemp, req.user.userId]
    )

    res.json({
      qr: qrDataUrl,        // base64 data URL for <img>
      secret: base32,       // plain text for manual entry in authenticator app
    })
  } catch (err) {
    logger.error('[2fa/setup] error:', { error: err.message })
    res.status(500).json({ error: 'Could not set up 2FA' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/2fa/verify-setup
//
// Verifies the first TOTP code from the user's authenticator app.
// If valid: promotes temp → live secret, enables 2FA, generates backup codes.
// Returns backup codes (shown ONCE — never again).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/2fa/verify-setup', authenticateToken, async function(req, res) {
  try {
    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    const userRow = await pool.query(
      `SELECT totp_temp_secret, totp_enabled FROM users WHERE id = $1`,
      [req.user.userId]
    )
    if (userRow.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    const { totp_temp_secret, totp_enabled } = userRow.rows[0]
    if (totp_enabled) return res.status(400).json({ error: '2FA is already active' })
    if (!totp_temp_secret) return res.status(400).json({ error: 'Run /2fa/setup first' })

    const plainTemp = totp.decryptSecret(totp_temp_secret)
    const valid     = totp.verifyToken(plainTemp, token)
    if (!valid) return res.status(401).json({ error: 'Invalid code. Please try again.' })

    // Generate 8 one-time backup codes
    const { plain, hashes } = await totp.generateBackupCodes()
    const backupJson = JSON.stringify(hashes.map(h => ({ hash: h, used: false })))

    // Promote temp → live secret, enable 2FA, store backup code hashes
    const encryptedLive = totp.encryptSecret(plainTemp)
    await pool.query(
      `UPDATE users SET
         totp_secret      = $1,
         totp_enabled     = TRUE,
         totp_temp_secret = NULL,
         totp_backup_codes = $2
       WHERE id = $3`,
      [encryptedLive, backupJson, req.user.userId]
    )

    logger.info(`[2fa] User ${req.user.userId} enabled 2FA`)
    res.json({
      message:      '2FA enabled successfully',
      backup_codes: plain,  // shown ONCE — user must save these
    })
  } catch (err) {
    logger.error('[2fa/verify-setup] error:', { error: err.message })
    res.status(500).json({ error: 'Could not activate 2FA' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/2fa/validate
//
// Called after /login when requires2FA === true.
// Accepts the pre2faToken (Authorization: Bearer <token>) + 6-digit OTP.
// If valid: issues the full session cookie & returns the user object.
// Also accepts backup codes (same endpoint — tries TOTP first, then backup).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/2fa/validate', twoFaValidateLimiter, authenticatePre2FA, async function(req, res) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown'

  // Per-IP rate limit check (5 failures → 15 min lock)
  const rl = totp.checkRateLimit(ip)
  if (rl.blocked) {
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${rl.remaining} minute(s).` })
  }

  try {
    const { token } = req.body
    if (!token) return res.status(400).json({ error: 'token required' })

    const { userId } = req.pre2fa
    const userRow = await pool.query(
      `SELECT id, email, full_name, country, kyc_status, affiliate_code, trader_uid,
              token_version, totp_enabled, totp_secret, totp_backup_codes
       FROM users WHERE id = $1`,
      [userId]
    )
    if (userRow.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    const user = userRow.rows[0]
    if (!user.totp_enabled || !user.totp_secret) {
      return res.status(400).json({ error: '2FA is not enabled on this account' })
    }

    const plainSecret = totp.decryptSecret(user.totp_secret)
    let validated     = totp.verifyToken(plainSecret, token)

    // Try backup code if TOTP fails
    if (!validated && user.totp_backup_codes) {
      let codes
      try { codes = JSON.parse(user.totp_backup_codes) } catch { codes = [] }
      const { matched, updated } = await totp.consumeBackupCode(token, codes)
      if (matched) {
        await pool.query(
          `UPDATE users SET totp_backup_codes = $1 WHERE id = $2`,
          [JSON.stringify(updated), userId]
        )
        validated = true
      }
    }

    if (!validated) {
      totp.recordFailure(ip)
      return res.status(401).json({ error: 'Invalid code. Please try again.' })
    }

    // Success — clear failure counter, issue full session
    totp.clearAttempts(ip)

    const tokenVersion = user.token_version || 1
    const fullToken = jwt.sign(
      { userId: user.id, email: user.email, tv: tokenVersion },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    )
    setAuthCookie(res, fullToken)

    res.json({
      message: 'Login successful',
      user: {
        id:            user.id,
        trader_id:     user.id,
        trader_uid:    user.trader_uid,
        email:         user.email,
        full_name:     user.full_name,
        country:       user.country,
        kyc_status:    user.kyc_status,
        affiliate_code: user.affiliate_code,
      }
    })
  } catch (err) {
    logger.error('[2fa/validate] error:', { error: err.message })
    res.status(500).json({ error: 'Could not verify 2FA token' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/2fa/disable
//
// Requires BOTH the user's account password AND a valid TOTP token.
// Clears totp_secret, sets totp_enabled = false.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/2fa/disable', authenticateToken, async function(req, res) {
  try {
    const { token, password } = req.body
    if (!token || !password) {
      return res.status(400).json({ error: 'Both password and 2FA token are required' })
    }

    const userRow = await pool.query(
      `SELECT password_hash, totp_enabled, totp_secret FROM users WHERE id = $1`,
      [req.user.userId]
    )
    if (userRow.rows.length === 0) return res.status(404).json({ error: 'User not found' })

    const user = userRow.rows[0]
    if (!user.totp_enabled) return res.status(400).json({ error: '2FA is not enabled' })

    // Verify password
    const pwValid = await bcrypt.compare(password, user.password_hash)
    if (!pwValid) return res.status(401).json({ error: 'Incorrect password' })

    // Verify TOTP
    const plainSecret = totp.decryptSecret(user.totp_secret)
    const codeValid   = totp.verifyToken(plainSecret, token)
    if (!codeValid) return res.status(401).json({ error: 'Invalid 2FA code' })

    await pool.query(
      `UPDATE users SET
         totp_enabled      = FALSE,
         totp_secret       = NULL,
         totp_temp_secret  = NULL,
         totp_backup_codes = NULL
       WHERE id = $1`,
      [req.user.userId]
    )

    logger.info(`[2fa] User ${req.user.userId} disabled 2FA`)
    res.json({ message: '2FA disabled successfully' })
  } catch (err) {
    logger.error('[2fa/disable] error:', { error: err.message })
    res.status(500).json({ error: 'Could not disable 2FA' })
  }
})
