'use strict'
/**
 * Admin Router — Main Entry Point (Modular)
 * ─────────────────────────────────────────────────────────────────────────────
 * Composes all admin sub-routers into a single Express router.
 * Replaces the monolithic routes/admin.js which was 9,832 lines.
 *
 * Sub-router map:
 *   auth.js          ← /login /logout /2fa/* /session /admin-users
 *   analytics.js     ← /announcement /leaderboard /signup-trends /saved-views
 *                       /tags /notes /entity-meta /export /email-jobs
 *   users.js         ← /traders /kyc /ban /unban /users/* /accounts (detail)
 *   payouts.js       ← /payouts /payouts/approve /payouts/reject /payouts/:id/flag
 *   commandCenter.js ← /command-center/* /risk-scores /account-health
 *   misc.js          ← /suspicious-accounts /audit-log /platform-analytics /bbook
 *   settings.js      ← /settings /price-feed-health /risk-dashboard /incidents
 *   rules.js         ← /rules /enforcement
 *   risk.js          ← /payout-fraud-scores /device-link-graph /news-protection
 *                       /rollover-guard /slippage-monitor /feed-anomalies
 *                       /challenge-funnel /cohort-analytics /aml-velocity
 *                       /kyc-sla /kyc-quality-flags /immutable-audit /four-eyes
 *                       /feature-flags /notifications /cases /dispute-workflow
 *                       /stress-simulator /scheduled-reports /emergency-kill
 *                       /kyc/document/:userId/:type
 *   helpers.js       ← shared pure utility functions (no router, no routes)
 *
 * Migration status: ✅ COMPLETE — all routes extracted from admin.js
 */

const express = require('express')
const router = express.Router()

// Sub-router imports
const authRouter         = require('./auth')
const analyticsRouter    = require('./analytics')
const usersRouter        = require('./users')
const payoutsRouter      = require('./payouts')
const commandCenterRouter = require('./commandCenter')
const miscRouter         = require('./misc')
const settingsRouter     = require('./settings')
const rulesRouter        = require('./rules')
const riskRouter         = require('./risk')

// Mount all sub-routers on the shared prefix-less namespace
// (the parent already mounts these at /api/admin)
router.use('/', authRouter)
router.use('/', analyticsRouter)
router.use('/', usersRouter)
router.use('/', payoutsRouter)
router.use('/', commandCenterRouter)
router.use('/', miscRouter)
router.use('/', settingsRouter)
router.use('/', rulesRouter)
router.use('/', riskRouter)

// Preserve the __test__ hook from the monolith for backward compatibility
const { buildKycDocumentPresencePredicate } = require('./helpers')
router.__test__ = { buildKycDocumentPresencePredicate }

module.exports = router
