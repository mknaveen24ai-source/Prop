// Admin API assembly point.
//
// This replaces the former 9,898-line routes/admin.js. The route table was split
// by domain into the sibling files below; this file only mounts them.
//
// Two rules govern this file, and breaking either one breaks production:
//
//   1. Sub-routers are mounted at the ROOT, with no path prefix. The admin URL
//      space is flat and not namespaced (POST /ban, GET /overview,
//      POST /kyc/approve), so `router.use('/users', usersRouter)` would rewrite
//      /ban to /users/ban and 404 every existing frontend call.
//
//   2. The mount order below matches the order the routes had in the original
//      file. Express matches in registration order, and some paths can shadow
//      others (GET /trades vs POST /trades/:tradeId/close, POST /cases/link vs
//      POST /cases), so reordering these lines can silently reroute requests.
//
// scripts/route-manifest.js prints every route in match order with its
// middleware-stack depth; diffing its output against the pre-split baseline is
// how both rules are verified.
const express = require('express')
const router = express.Router()

// Auth deliberately mounts first and applies its own per-route middleware:
// /login and /logout take none, and /2fa/validate uses authenticateAdminPre2FA.
// Do NOT hoist authenticateAdmin to a router.use() here — it would lock out login.
router.use(require('./auth'))
router.use(require('./adminUsers'))
router.use(require('./overview'))
router.use(require('./workspace'))
router.use(require('./exportData'))
router.use(require('./emailJobs'))
router.use(require('./traders'))
router.use(require('./accounts'))
// Paths here (/promotion-reviews, /account-batches) do not collide with
// ./accounts' /accounts* space, so this slots in after it without shadowing.
router.use(require('./promotionReviews'))
router.use(require('./trades'))
router.use(require('./payouts'))
router.use(require('./certificates'))
router.use(require('./commandCenter'))
router.use(require('./commandCenterActions'))
router.use(require('./reporting'))
router.use(require('./settings'))
router.use(require('./stepModels'))
router.use(require('./compliance'))
// /account-links* is its own path space — no collision with ./compliance's
// /enforcement, /payout-fraud-scores or /device-link-graph.
router.use(require('./accountLinking'))
router.use(require('./riskGuards'))
router.use(require('./analytics'))
router.use(require('./kycReview'))
router.use(require('./governance'))
router.use(require('./support'))
router.use(require('./operations'))
router.use(require('./kycDocuments'))

// --- Back-compat export surface ---------------------------------------------
// Seven sibling admin routers (adminAffiliates, adminCompetitions, adminCoupons,
// adminGifts, adminReferralSeasons, adminTradingEconomics, adminAnalytics) and
// test/adminRoutes.test.js read these off the router. Keeping them here means
// none of those files needed to change when admin.js was split.
const { buildAdminSessionPayload } = require('../middleware')
const { ensureFeatureTables } = require('./shared/schema')
const {
  getAdminActorLabel, buildAdminActorPayload, appendImmutableAudit
} = require('./shared/audit')
const {
  signAdminToken, setAdminCookie, isBcryptHash, looksLikeDefaultSecret,
  normalizeAdminEmail, getActivePlatformAdminCount, getPlatformAdminByEmail,
  getPlatformAdminById, buildAdminJwtPayload, parsePositiveInteger,
  parseBooleanFilter, parseCsvListParam, parseListPaging, buildPagination,
  paginateRows, facetCounts, toIsoOrNull, normalizeEntityId, normalizeAdminTag,
  normalizeEntityType, getAdminOwnerId, wantsAdminListContract,
  computeUserLifecycleStage, computeAccountLifecycleStage,
  computePayoutComplianceStatus, buildSavedViewCapabilities,
  normalizeAccountSnapshot, normalizeUserSnapshot, normalizePayoutSnapshot,
  normalizeViolationSnapshot, buildAllowedAccountActions, buildAllowedUserActions,
  buildAllowedPayoutActions, buildAllowedViolationActions, upsertAdminEntityMeta,
  computePhaseEndDateForAccountType, buildKycDocumentPresencePredicate
} = require('./shared/helpers')
const { buildAccountListResult } = require('./shared/listBuilders')
const {
  forceCloseOpenTradesForAccount, cancelPendingTradesForAccount,
  forceCloseTradeById, calcTradePnl, getExposureData
} = require('./shared/tradeOps')

router.__test__ = {
  buildKycDocumentPresencePredicate
}

router._internals = {
  signAdminToken,
  setAdminCookie,
  isBcryptHash,
  looksLikeDefaultSecret,
  normalizeAdminEmail,
  getActivePlatformAdminCount,
  getPlatformAdminByEmail,
  getPlatformAdminById,
  buildAdminJwtPayload,
  buildAdminSessionPayload,
  ensureFeatureTables,
  parsePositiveInteger,
  parseBooleanFilter,
  parseCsvListParam,
  parseListPaging,
  buildPagination,
  paginateRows,
  facetCounts,
  toIsoOrNull,
  normalizeEntityId,
  normalizeAdminTag,
  normalizeEntityType,
  getAdminOwnerId,
  getAdminActorLabel,
  buildAdminActorPayload,
  wantsAdminListContract,
  computeUserLifecycleStage,
  computeAccountLifecycleStage,
  computePayoutComplianceStatus,
  buildSavedViewCapabilities,
  normalizeAccountSnapshot,
  normalizeUserSnapshot,
  normalizePayoutSnapshot,
  normalizeViolationSnapshot,
  buildAllowedAccountActions,
  buildAllowedUserActions,
  buildAllowedPayoutActions,
  buildAllowedViolationActions,
  forceCloseOpenTradesForAccount,
  cancelPendingTradesForAccount,
  forceCloseTradeById,
  calcTradePnl,
  upsertAdminEntityMeta,
  computePhaseEndDateForAccountType,
  appendImmutableAudit,
  buildKycDocumentPresencePredicate,
  getExposureData,
  buildAccountListResult,
}

module.exports = router;
