const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const rateLimit = require('express-rate-limit')
const { sendPasswordReset } = require('../mailer')
const { passwordResetLimiter } = require('../utils/security')
const { isValidEmail, isValidPassword, sanitizeString } = require('../utils/validation')
const logger = require('../utils/logger')
require('dotenv').config()

const BLOCKED_COUNTRIES = ['United States', 'Canada', 'Iran', 'North Korea', 'Cuba', 'Syria']

const COOKIE_BASE = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  path: '/'
}

function setAuthCookie(res, token) {
  res.cookie('token', token, { ...COOKIE_BASE, maxAge: 7 * 24 * 60 * 60 * 1000 })
}

function clearAuthCookie(res) {
  res.clearCookie('token', COOKIE_BASE)
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
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    )
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' })
    }

    if (device_fingerprint) {
      const existingDevice = await pool.query(
        'SELECT id FROM users WHERE device_fingerprint = $1',
        [device_fingerprint]
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
       (email, password_hash, full_name, country, phone, referred_by, device_fingerprint, affiliate_code, trader_uid)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, email, full_name, country, kyc_status, affiliate_code, trader_uid, token_version`,
      [
        email.toLowerCase(),
        password_hash,
        full_name,
        countryTrimmed,
        phone,
        referred_by || null,
        device_fingerprint || null,
        affiliate_code,
        trader_uid
      ]
    )

    const user = newUser.rows[0]
    const tokenVersion = user.token_version || 1
    const token = jwt.sign(
      { userId: user.id, email: user.email, tv: tokenVersion },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    )

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
        affiliate_code: user.affiliate_code
      }
    })

  } catch (error) {
    logger.error('Register error:', { error: error.message, email: req.body?.email || null })
    res.status(500).json({ error: 'Server error during registration' })
  }
})

router.post('/login', loginLimiter, async function(req, res) {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' })
    }

    if (!isValidEmail(email)) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const result = await pool.query(
      'SELECT id, email, password_hash, full_name, country, kyc_status, is_banned,' +
      ' affiliate_code, trader_uid, token_version FROM users WHERE email = $1',
      [email.toLowerCase()]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const user = result.rows[0]

    // FIX: trader_uid backfill handled in server.js startup â€” not on every login
    const traderUid = user.trader_uid

    if (user.is_banned) {
      return res.status(403).json({ error: 'Account has been suspended' })
    }

    const validPassword = await bcrypt.compare(password, user.password_hash)
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const tokenVersion = user.token_version || 1
    const token = jwt.sign(
      { userId: user.id, email: user.email, tv: tokenVersion },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    )

    setAuthCookie(res, token)

    // IP logging â€” non-fatal
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
        affiliate_code: user.affiliate_code
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
              affiliate_code, is_banned, theme_preference, trader_uid
       FROM users WHERE id = $1`,
      [req.user.userId]
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
      theme_preference: user.theme_preference || 'dark'
    })
  } catch (error) {
    logger.error('Get me error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch user' })
  }
})

router.post('/forgot-password', passwordResetLimiter, async function(req, res) {
  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ error: 'Email is required' })
    }

    if (!isValidEmail(email)) {
      return res.json({ message: 'If that email is registered, a reset link has been sent.' })
    }

    const result = await pool.query(
      'SELECT id, email FROM users WHERE email = $1',
      [email.toLowerCase()]
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

    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${rawToken}&email=${encodeURIComponent(user.email)}`

    await sendPasswordReset(user.email, resetLink)

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

router.post('/reset-password', async function(req, res) {
  try {
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
      'SELECT id, reset_token, reset_token_expires FROM users WHERE email = $1',
      [email.toLowerCase()]
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

    res.json({ message: 'Password reset successfully. You can now log in.' })

  } catch (error) {
    logger.error('Reset password error:', { error: error.message })
    res.status(500).json({ error: 'Server error' })
  }
})

// Logout â€” clear auth cookie only (single device)
router.post('/logout', function(req, res) {
  clearAuthCookie(res)
  res.json({ message: 'Logged out' })
})

// Logout all â€” invalidate every session for this user across all devices
router.post('/logout-all', authenticateToken, async function(req, res) {
  try {
    await pool.query(
      `UPDATE users SET token_version = COALESCE(token_version, 1) + 1 WHERE id = $1`,
      [req.user.userId]
    )
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
       GROUP BY u.id`,
      [parseInt(userId)]
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
       WHERE a.user_id = $1 AND t.status = 'closed'`,
      [parseInt(userId)]
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
