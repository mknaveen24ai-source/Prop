// Admin API assembly point. Sub-routers mount at the root in the exact legacy
// order because the admin URL space is flat and Express matching is ordered.

import express from 'express'
import type { Router } from 'express'

interface AdminRouter extends Router {
  __test__: Record<string, unknown>
  _internals: Record<string, unknown>
}

const router = express.Router() as AdminRouter

// Auth deliberately mounts first and applies its own per-route middleware.
router.use(require('./auth') as Router)
router.use(require('./adminUsers') as Router)
router.use(require('./overview') as Router)
router.use(require('./workspace') as Router)
router.use(require('./exportData') as Router)
router.use(require('./emailJobs') as Router)
router.use(require('./traders') as Router)
router.use(require('./accounts') as Router)
router.use(require('./promotionReviews') as Router)
router.use(require('./trades') as Router)
router.use(require('./payouts') as Router)
router.use(require('./certificates') as Router)
router.use(require('./commandCenter') as Router)
router.use(require('./commandCenterActions') as Router)
router.use(require('./reporting') as Router)
router.use(require('./settings') as Router)
router.use(require('./stepModels') as Router)
router.use(require('./compliance') as Router)
router.use(require('./accountLinking') as Router)
router.use(require('./riskGuards') as Router)
router.use(require('./analytics') as Router)
router.use(require('./kycReview') as Router)
router.use(require('./governance') as Router)
router.use(require('./support') as Router)
router.use(require('./operations') as Router)
router.use(require('./kycDocuments') as Router)
router.use(require('./intelligence') as Router)
router.use(require('./traderIntelligence') as Router)

// Back-compat export surface used by sibling admin routers and legacy tests.
const middleware = require('../middleware') as Record<string, unknown>
const schema = require('./shared/schema') as Record<string, unknown>
const audit = require('./shared/audit') as Record<string, unknown>
const helpers = require('./shared/helpers') as Record<string, unknown>
const listBuilders = require('./shared/listBuilders') as Record<string, unknown>
const tradeOps = require('./shared/tradeOps') as Record<string, unknown>

const {
  buildAdminSessionPayload
} = middleware
const {
  ensureFeatureTables
} = schema
const {
  appendImmutableAudit,
  buildAdminActorPayload,
  getAdminActorLabel
} = audit
const {
  buildAdminJwtPayload,
  buildAllowedAccountActions,
  buildAllowedPayoutActions,
  buildAllowedUserActions,
  buildAllowedViolationActions,
  buildKycDocumentPresencePredicate,
  buildPagination,
  buildSavedViewCapabilities,
  computeAccountLifecycleStage,
  computePayoutComplianceStatus,
  computePhaseEndDateForAccountType,
  computeUserLifecycleStage,
  facetCounts,
  getActivePlatformAdminCount,
  getAdminOwnerId,
  getPlatformAdminByEmail,
  getPlatformAdminById,
  isBcryptHash,
  looksLikeDefaultSecret,
  normalizeAccountSnapshot,
  normalizeAdminEmail,
  normalizeAdminTag,
  normalizeEntityId,
  normalizeEntityType,
  normalizePayoutSnapshot,
  normalizeUserSnapshot,
  normalizeViolationSnapshot,
  paginateRows,
  parseBooleanFilter,
  parseCsvListParam,
  parseListPaging,
  parsePositiveInteger,
  setAdminCookie,
  signAdminToken,
  toIsoOrNull,
  upsertAdminEntityMeta,
  wantsAdminListContract
} = helpers
const { buildAccountListResult } = listBuilders
const {
  calcTradePnl,
  cancelPendingTradesForAccount,
  forceCloseOpenTradesForAccount,
  forceCloseTradeById,
  getExposureData
} = tradeOps

router.__test__ = { buildKycDocumentPresencePredicate }

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
  buildAccountListResult
}

export = router
