/**
 * ─────────────────────────────────────────────────────────────────────────────
 * routes/setup.js — First-Run Setup API
 *
 * Provides a safe, one-time setup flow for new client deployments.
 *
 * Endpoints:
 *   GET  /api/setup/status  — Returns whether platform needs first-run setup
 *   POST /api/setup/init    — Seeds platform settings + initialises admin
 *
 * Security: Once setup is complete (admin_token_version exists in DB),
 * the /init endpoint becomes permanently unavailable (returns 409).
 * ─────────────────────────────────────────────────────────────────────────────
 */
const express  = require('express')
const router   = express.Router()
const pool     = require('../db')
const bcrypt   = require('bcryptjs')
const logger   = require('../utils/logger')
const { createLimiter } = require('../utils/security')
const { resolveMailTransportConfig } = require('../mailer')

// Only allow 5 setup attempts per hour (prevents brute-force seeding)
const setupLimiter = createLimiter('setup', {
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many setup attempts. Try again in 1 hour.' },
  standardHeaders: true,
  legacyHeaders: false
})

// ── Check if platform is already initialized ──────────────────────────────────
async function isPlatformInitialized() {
  try {
    const result = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'admin_token_version' LIMIT 1`
    )
    return result.rows.length > 0
  } catch {
    // Table might not exist yet on very first run
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/setup/status
//
// Returns whether the platform needs first-run initialization.
// Safe to call from the frontend without auth — reveals no sensitive data.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', async function(req, res) {
  try {
    const initialized = await isPlatformInitialized()
    res.json({
      initialized,
      message: initialized
        ? 'Platform is already configured. Please log in.'
        : 'Platform needs first-run setup. POST to /api/setup/init to initialize.'
    })
  } catch (err) {
    logger.error('[setup/status] error:', { error: err.message })
    res.status(500).json({ error: 'Could not check platform status' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/setup/init
//
// Seeds all default platform settings and initialises the admin_token_version.
// Once the platform is initialized, this endpoint is permanently locked (409).
//
// Body (all optional — defaults are sane):
// {
//   "setup_key": "<SETUP_KEY env var — required if set>",
//   "platform_name": "My Firm",
//   "phase1_profit_target_pct": 10,
//   "phase1_max_drawdown_pct": 10,
//   "phase2_profit_target_pct": 5,
//   "phase2_max_drawdown_pct": 5,
//   "funded_max_drawdown_pct": 4,
//   "profit_share_pct": 75,
//   "min_payout_amount": 50
// }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/init', setupLimiter, async function(req, res) {
  try {
    // Guard: permanently reject if already initialized
    const initialized = await isPlatformInitialized()
    if (initialized) {
      return res.status(409).json({
        error: 'Platform is already initialized. This endpoint is permanently disabled.',
        hint: 'To re-seed settings, use the Admin Panel > Settings page.'
      })
    }

    // Optional setup key environment guard — set SETUP_KEY in .env to protect this endpoint
    const envSetupKey = process.env.SETUP_KEY
    if (envSetupKey) {
      const { setup_key } = req.body
      if (!setup_key || setup_key !== envSetupKey) {
        return res.status(401).json({ error: 'Invalid setup key' })
      }
    }

    const {
      platform_name             = process.env.PLATFORM_NAME || 'PropFirm',
      phase1_profit_target_pct  = 10,
      phase1_max_drawdown_pct   = 10,
      phase1_day_limit          = 30,
      phase2_profit_target_pct  = 5,
      phase2_max_drawdown_pct   = 5,
      phase2_day_limit          = 30,
      funded_max_drawdown_pct   = 4,
      profit_share_pct          = 75,
      max_accounts_per_user     = 5,
      min_payout_amount         = 50,
      min_hold_seconds          = 60,
      forex_lots_per_1k         = 0.10,
      commodity_lots_per_1k     = 0.02,
      min_lot_size              = 0.01,
      max_trades_per_1k         = 5,
      max_open_positions        = 10,
      max_daily_trades          = 20,
      weekend_holding_enabled   = true,
      inactivity_auto_fail_enabled = true,
      inactivity_fail_days      = 30,
      drawdown_type             = 'trailing',
    } = req.body

    // Validate critical numeric inputs
    const numericFields = {
      phase1_profit_target_pct, phase1_max_drawdown_pct,
      phase2_profit_target_pct, phase2_max_drawdown_pct,
      funded_max_drawdown_pct, profit_share_pct,
      min_payout_amount
    }
    for (const [key, val] of Object.entries(numericFields)) {
      const n = parseFloat(val)
      if (isNaN(n) || n < 0 || n > 1000) {
        return res.status(400).json({ error: `Invalid value for ${key}: ${val}` })
      }
    }

    // Ensure tables exist first
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    // All default settings — idempotent (DO NOTHING on conflict)
    const settings = [
      ['admin_token_version',          '1'],
      ['platform_name',                String(platform_name)],
      ['phase1_profit_target_pct',     String(phase1_profit_target_pct)],
      ['phase1_max_drawdown_pct',      String(phase1_max_drawdown_pct)],
      ['phase1_day_limit',             String(phase1_day_limit)],
      ['phase2_profit_target_pct',     String(phase2_profit_target_pct)],
      ['phase2_max_drawdown_pct',      String(phase2_max_drawdown_pct)],
      ['phase2_day_limit',             String(phase2_day_limit)],
      ['funded_max_drawdown_pct',      String(funded_max_drawdown_pct)],
      ['profit_share_pct',             String(profit_share_pct)],
      ['max_accounts_per_user',        String(max_accounts_per_user)],
      ['min_payout_amount',            String(min_payout_amount)],
      ['min_hold_seconds',             String(min_hold_seconds)],
      ['forex_lots_per_1k',            String(forex_lots_per_1k)],
      ['commodity_lots_per_1k',        String(commodity_lots_per_1k)],
      ['min_lot_size',                 String(min_lot_size)],
      ['max_trades_per_1k',            String(max_trades_per_1k)],
      ['max_open_positions',           String(max_open_positions)],
      ['max_daily_trades',             String(max_daily_trades)],
      ['weekend_holding_enabled',      String(weekend_holding_enabled)],
      ['inactivity_auto_fail_enabled', String(inactivity_auto_fail_enabled)],
      ['inactivity_fail_days',         String(inactivity_fail_days)],
      ['drawdown_type',                String(drawdown_type)],
      ['price_history_retain_days',    '7'],
      ['announcement_enabled',         'false'],
      ['announcement_message',         ''],
      ['leaderboard_enabled',          'true'],
    ]

    for (const [key, value] of settings) {
      await pool.query(
        `INSERT INTO platform_settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [key, value]
      )
    }

    const seededCount = settings.length
    logger.info(`[setup/init] Platform initialized: ${seededCount} settings seeded`)

    res.status(201).json({
      success: true,
      message: 'Platform initialized successfully.',
      seeded_settings: seededCount,
      next_steps: [
        '1. Log in to the admin panel at /admin',
        '2. Go to Admin > Settings to configure your challenge rules',
        '3. Set your profit share percentage and payout minimum',
        '4. Configure your account size quotas',
        '5. Set up email (SMTP) in your .env file',
        '6. Test by creating a challenge account from the trader dashboard'
      ]
    })

  } catch (err) {
    logger.error('[setup/init] error:', { error: err.message })
    res.status(500).json({ error: 'Setup failed. Check server logs.' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/setup/checklist
//
// Returns a structured onboarding checklist with real-time completion status.
// Authenticated admins can use this to track what still needs to be configured.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/checklist', async function(req, res) {
  try {
    const checks = []

    // 1. Platform settings initialized?
    const settingsResult = await pool.query(
      `SELECT COUNT(*) as count FROM platform_settings`
    )
    const settingsCount = parseInt(settingsResult.rows[0].count || 0)
    checks.push({
      id: 'platform_settings',
      title: 'Platform settings configured',
      complete: settingsCount >= 10,
      detail: `${settingsCount} settings in database`,
      action: 'Admin > Settings'
    })

    // 2. At least one KYC user approved?
    const kycResult = await pool.query(
      `SELECT COUNT(*) as count FROM users WHERE kyc_status = 'approved' LIMIT 1`
    )
    checks.push({
      id: 'kyc_flow',
      title: 'KYC review flow tested',
      complete: parseInt(kycResult.rows[0].count) > 0,
      detail: `${kycResult.rows[0].count} approved KYC`,
      action: 'Admin > KYC'
    })

    // 3. At least one challenge account created?
    const accountResult = await pool.query(
      `SELECT COUNT(*) as count FROM accounts LIMIT 1`
    )
    checks.push({
      id: 'challenge_created',
      title: 'Challenge account creation tested',
      complete: parseInt(accountResult.rows[0].count) > 0,
      detail: `${accountResult.rows[0].count} accounts in system`,
      action: 'Trader Dashboard > New Challenge'
    })

    // 4. Email configured?
    const mailTransport = resolveMailTransportConfig()
    const emailConfigured = mailTransport.mode !== 'preview'
    checks.push({
      id: 'email_configured',
      title: 'Email (SMTP) configured',
      complete: emailConfigured,
      detail: emailConfigured
        ? `${mailTransport.provider}${mailTransport.host ? ` via ${mailTransport.host}:${mailTransport.port}` : ''}`
        : 'No SMTP configured - local preview transport only',
      action: 'Edit .env file — add SMTP_HOST + SMTP_USER + SMTP_PASS'
    })

    // 5. Profit share set to non-default?
    const profitResult = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'profit_share_pct' LIMIT 1`
    )
    const profitShare = profitResult.rows[0]?.value
    checks.push({
      id: 'profit_share',
      title: 'Profit share percentage set',
      complete: profitShare !== undefined && profitShare !== '80',
      detail: profitShare ? `Currently ${profitShare}% (default is 80%)` : 'Not set',
      action: 'Admin > Settings > Profit Share'
    })

    // 6. Account size quotas configured?
    const quotaResult = await pool.query(
      `SELECT COUNT(*) as count FROM platform_settings WHERE key LIKE 'quota_%' AND value != '' AND value != '0'`
    )
    checks.push({
      id: 'quotas_configured',
      title: 'Account size quotas unlocked',
      complete: parseInt(quotaResult.rows[0].count) > 0,
      detail: `${quotaResult.rows[0].count} account sizes enabled`,
      action: 'Admin > Settings > Account Sizes'
    })

    // 7. At least one payout processed?
    let payoutComplete = false
    try {
      const payoutResult = await pool.query(
        `SELECT COUNT(*) as count FROM payouts WHERE status = 'paid' LIMIT 1`
      )
      payoutComplete = parseInt(payoutResult.rows[0].count) > 0
    } catch { /* table may not exist yet */ }
    checks.push({
      id: 'payout_tested',
      title: 'Payout workflow tested',
      complete: payoutComplete,
      detail: payoutComplete ? 'At least one payout paid' : 'No paid payouts yet',
      action: 'Admin > Payouts'
    })

    // 8. Admin 2FA enabled?
    const admin2faResult = await pool.query(
      `SELECT value FROM platform_settings WHERE key = 'admin_totp_secret' LIMIT 1`
    )
    checks.push({
      id: 'admin_2fa',
      title: 'Admin 2FA (TOTP) enabled',
      complete: admin2faResult.rows.length > 0 && !!admin2faResult.rows[0].value,
      detail: admin2faResult.rows.length > 0 ? '2FA active' : '2FA not configured',
      action: 'Admin > Settings > Security > Enable 2FA'
    })

    const completedCount = checks.filter(c => c.complete).length
    const totalCount = checks.length

    res.json({
      progress: {
        completed: completedCount,
        total: totalCount,
        percentage: Math.round((completedCount / totalCount) * 100)
      },
      checks,
      ready_for_traders: completedCount >= 5
    })

  } catch (err) {
    logger.error('[setup/checklist] error:', { error: err.message })
    res.status(500).json({ error: 'Could not load checklist' })
  }
})

module.exports = router
