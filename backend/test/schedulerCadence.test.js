const test = require('node:test')
const assert = require('node:assert/strict')

const schedulerService = require('../services/schedulerService')

// The trading loops run at one of two cadences: the real ones (500/500/1000ms)
// when they ARE the engine, and a slow safety net (5s/5s/10s) when the
// event-driven engine is carrying the load instead.
//
// Picking between them off the ENGINE_MODE env var was wrong in one specific,
// silent case: startPriceFeedPipeline sets _engineEnabled = false when
// initializeEngine() throws, but the env var still says `event`. The loops were
// then demoted to the safety net at the exact moment they became the only path,
// taking stop-loss reaction from 50-80ms to five seconds with nothing but a
// single log line to say so.
//
// These tests pin the cadence to what the engine is ACTUALLY doing.

/**
 * Runs startAllSchedulers against stub jobs and reports the interval each was
 * registered at, then clears every timer it created.
 */
function cadencesFor(options) {
  const registered = []
  const originalSetInterval = global.setInterval
  global.setInterval = function (fn, ms) {
    registered.push(ms)
    return originalSetInterval(function () {}, 1 << 30)
  }

  const noop = () => {}
  const deps = {
    checkSLTP: noop,
    checkPendingOrders: noop,
    checkFloatingDrawdown: noop,
    runChallengeEngine: noop,
    runCompetitionEngine: noop,
    runReferralSeasonEngine: noop,
    tickCompetitionBots: noop,
    checkNewsForceClose: noop,
    weekendForceCloseByTenant: noop,
    flatByCloseForAccounts: noop,
    pruneOldPriceHistory: noop,
    syncHourlyPriceHistory: noop,
    syncDedicatedPriceFeedWatchers: async () => {},
    processQueuedNotifications: noop,
    runAccountLinkingScan: noop,
    pruneIdentitySignals: noop
  }

  try {
    schedulerService.startAllSchedulers(null, deps, options)
  } finally {
    global.setInterval = originalSetInterval
    schedulerService.clearTrackedTimers()
  }
  return registered
}

const INTERVAL = schedulerService.INTERVAL_CADENCES
const FALLBACK = schedulerService.EVENT_FALLBACK_CADENCES

test('an armed event engine demotes the trading loops to the safety net', () => {
  const registered = cadencesFor({ eventEngineArmed: true })

  assert.ok(
    registered.includes(FALLBACK.checkSLTP),
    `expected an SL/TP loop at the ${FALLBACK.checkSLTP}ms fallback cadence`
  )
  assert.ok(
    !registered.includes(INTERVAL.checkSLTP),
    'the 500ms loop is redundant work once the tick drives SL/TP'
  )
})

test('an engine that did NOT arm keeps the real cadences, whatever ENGINE_MODE says', () => {
  // The regression: ENGINE_MODE=event, initializeEngine() threw, so nothing is
  // driving SL/TP off the price tick. Demoting here would leave stop losses
  // firing up to five seconds late.
  const previous = process.env.ENGINE_MODE
  process.env.ENGINE_MODE = 'event'
  try {
    const registered = cadencesFor({ eventEngineArmed: false })

    assert.ok(
      registered.includes(INTERVAL.checkSLTP),
      `expected the SL/TP loop to stay at ${INTERVAL.checkSLTP}ms when nothing else is checking stop losses`
    )
    assert.ok(
      !registered.includes(FALLBACK.checkSLTP),
      'demoting to the safety net with no event engine is the bug this guards'
    )
  } finally {
    if (previous === undefined) delete process.env.ENGINE_MODE
    else process.env.ENGINE_MODE = previous
  }
})

test('omitting the flag falls back to ENGINE_MODE so old callers are unchanged', () => {
  const previous = process.env.ENGINE_MODE
  process.env.ENGINE_MODE = 'interval'
  try {
    const registered = cadencesFor({})
    assert.ok(registered.includes(INTERVAL.checkSLTP))
  } finally {
    if (previous === undefined) delete process.env.ENGINE_MODE
    else process.env.ENGINE_MODE = previous
  }
})
