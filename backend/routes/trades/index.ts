// NOTE: All date operations should use UTC methods (getUTC*, setUTC*)
// to ensure consistent behavior across timezones
//
// Trades API assembly point. This replaces the former 2,111-line
// routes/trades.js; the route table was split by domain into the sibling files
// below and this file only mounts them.
//
// Two rules govern this file, the same two that govern routes/admin/index.js,
// and breaking either one breaks production:
//
//   1. Sub-routers mount at the ROOT, with no path prefix. The trades URL space
//      is flat (/open, /close, /candles), so router.use('/orders', ...) would
//      rewrite /open to /orders/open and 404 every frontend call.
//
//   2. The mount order below matches the order the routes had in the original
//      file. Express matches in registration order. No route here can actually
//      shadow another (only /:tradeId/screenshot/:kind takes params, and no
//      literal path has three segments), but preserving the order is what lets
//      scripts/route-manifest.js diff clean against the pre-split baseline —
//      and an empty diff is a stronger signal than one you have to reason about.
//
// Verify with:
//   node scripts/route-manifest.js ./routes/trades
import express from 'express'
import type { Router } from 'express'
import type tradeEngineModule = require('../../services/tradeEngine')
import type tradeSharedModule = require('../../services/tradeShared')
import type * as pnlCalculatorModule from '../../utils/pnlCalculator'

const router = express.Router()

router.use(require('./charts') as Router)
router.use(require('./open') as Router)
router.use(require('./close') as Router)
router.use(require('./modify') as Router)
router.use(require('./history') as Router)
router.use(require('./analytics') as Router)
router.use(require('./batch') as Router)
router.use(require('./screenshots') as Router)

// The engine functions live in services/tradeEngine.js and the shared helpers
// in services/tradeShared.js. They are re-exported here so existing importers
// (server.js, weekendCloseService, competitionEngine, adminAnalytics,
// utils/bootstrap) keep working against the original names — none of them had
// to change for this split.
//
// tradeEngine is required AFTER the mounts above, as it was in the single-file
// version: services/tradeEngine.js is reached through this module's own import
// graph, and hoisting this line would make the load order depend on which side
// Node happened to reach first.
const tradeEngine = require('../../services/tradeEngine') as typeof tradeEngineModule
const { calculatePnL } = require('../../utils/pnlCalculator') as typeof pnlCalculatorModule
const {
  ensureTradeExperienceInfrastructure,
  computeRMultiple,
  getTradingRules,
  getLivePriceMap,
  getMarketStatus
} = require('../../services/tradeShared') as typeof tradeSharedModule

const trades = {
  router,
  checkSLTP: tradeEngine.checkSLTP,
  checkPendingOrders: tradeEngine.checkPendingOrders,
  checkFloatingDrawdown: tradeEngine.checkFloatingDrawdown,
  getTradingRules,
  getMarketStatus,
  ensureTradeExperienceInfrastructure,
  calculatePnL,
  getLivePriceMap,
  computeRMultiple
}

export = trades
