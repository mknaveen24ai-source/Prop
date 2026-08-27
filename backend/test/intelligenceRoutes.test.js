// Guards for the two admin intelligence pages.
//
// The load-bearing property of both routers is that they are READ-ONLY: the
// pages they serve have no controls, and nothing behind them may ever mutate.
// That is easy to state and easy to erode — someone adds "just one" approve
// button in six months. These tests make the erosion fail CI rather than ship.

const test = require('node:test')
const assert = require('node:assert/strict')

const intelligenceRouter = require('../routes/admin/intelligence')
const traderIntelligenceRouter = require('../routes/admin/traderIntelligence')
const registry = require('../services/analytics/registry')
const helpers = require('../services/analytics/helpers')

// Express keeps its route table on router.stack; each layer carries the methods
// it was registered for.
function routesOf (router) {
  return router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      path: layer.route.path,
      methods: Object.keys(layer.route.methods).filter((m) => m !== '_all')
    }))
}

test('both intelligence routers are strictly read-only', () => {
  for (const [name, router] of [['intelligence', intelligenceRouter], ['traderIntelligence', traderIntelligenceRouter]]) {
    const routes = routesOf(router)
    assert.ok(routes.length > 0, `${name} registered no routes at all`)

    for (const route of routes) {
      assert.deepEqual(
        route.methods,
        ['get'],
        `${name} route ${route.path} registers ${route.methods.join('/')} — these pages must never mutate anything`
      )
    }
  }
})

test('intelligence routes stay inside their own path prefix', () => {
  // The admin URL space is flat and unnamespaced (see routes/admin/index.js), so
  // a new router is only safe to mount if its paths cannot collide with an
  // existing one. These prefixes are what makes that true.
  for (const route of routesOf(intelligenceRouter)) {
    assert.ok(
      route.path.startsWith('/intelligence/'),
      `${route.path} escapes the /intelligence/ prefix and could shadow an existing admin route`
    )
  }
  for (const route of routesOf(traderIntelligenceRouter)) {
    assert.ok(
      route.path.startsWith('/trader-intelligence/'),
      `${route.path} escapes the /trader-intelligence/ prefix and could shadow an existing admin route`
    )
  }
})

test('every route is authenticated', () => {
  for (const [name, router] of [['intelligence', intelligenceRouter], ['traderIntelligence', traderIntelligenceRouter]]) {
    for (const layer of router.stack.filter((l) => l.route)) {
      const handlers = layer.route.stack.map((s) => s.name)
      assert.ok(
        handlers.includes('authenticateAdmin'),
        `${name} route ${layer.route.path} is not behind authenticateAdmin`
      )
    }
  }
})

test('the catalogue describes exactly 150 analyses, evenly split across the two pages', () => {
  assert.equal(registry.METRICS.length, 150)

  const ids = registry.METRICS.map((m) => m.id)
  assert.equal(new Set(ids).size, 150, 'duplicate metric ids in the registry')

  const byPage = registry.METRICS.reduce((acc, m) => {
    acc[m.page] = (acc[m.page] || 0) + 1
    return acc
  }, {})
  assert.equal(byPage[registry.PAGES.FIRM], 75)
  assert.equal(byPage[registry.PAGES.TRADER], 75)
})

test('every catalogue entry is complete and lands on a real tab', () => {
  for (const metric of registry.METRICS) {
    assert.ok(metric.name, `${metric.id} has no name`)
    assert.ok(metric.definition, `${metric.id} has no definition`)
    assert.ok(Array.isArray(metric.tables) && metric.tables.length > 0, `${metric.id} names no source tables`)
    assert.ok(registry.TABS[metric.tab], `${metric.id} points at unknown tab "${metric.tab}"`)
    assert.equal(
      registry.TABS[metric.tab].page,
      metric.page,
      `${metric.id} is on page ${metric.page} but its tab lives on ${registry.TABS[metric.tab].page}`
    )
    // A metric that needs data the deployment may not have must say what it
    // needs, so the UI can explain the gap instead of rendering a silent zero.
    if (metric.status === 'conditional') {
      assert.ok(metric.requires, `${metric.id} is conditional but names no prerequisite`)
    }
  }
})

test('date ranges are clamped so a bad end date cannot empty the page', () => {
  const today = new Date().toISOString().slice(0, 10)

  // A future end date used to slide the whole window past every row in the
  // database once the max-window clamp applied — a blank page from a typo.
  const future = helpers.parseDateRange({ from: '2024-01-01', to: '2999-01-01' })
  assert.equal(future.to, today)

  // The window itself is bounded, so a from-date years back cannot table-scan
  // the whole of `trades`.
  const ancient = helpers.parseDateRange({ from: '1990-01-01' })
  const spanDays = (new Date(ancient.to) - new Date(ancient.from)) / 86400000
  assert.ok(spanDays <= helpers.MAX_WINDOW_DAYS, `window of ${spanDays} days exceeds the cap`)

  // No dates at all still gives a usable default rather than everything.
  const fallback = helpers.parseDateRange({})
  const defaultSpan = (new Date(fallback.to) - new Date(fallback.from)) / 86400000
  assert.equal(Math.round(defaultSpan), helpers.DEFAULT_WINDOW_DAYS)
})

test('statistical helpers behave at their edges', () => {
  // Percentiles on a known series.
  assert.equal(helpers.percentile([1, 2, 3, 4, 5], 0.5), 3)
  assert.equal(helpers.median([4, 1, 3, 2]), 2.5)

  // Division guards: the whole point is that no metric ever renders NaN or
  // Infinity, so an absent answer must come back as null.
  assert.equal(helpers.safeDiv(1, 0), null)
  assert.equal(helpers.pct(0, 0), null)
  assert.equal(helpers.ratio(5, 0), null)

  // A coefficient of variation needs at least two points and a non-zero mean.
  assert.equal(helpers.coefficientOfVariation([5]), null)
  assert.equal(helpers.coefficientOfVariation([4, 4, 4]), 0)

  // Correlation of a series with itself is 1; with a constant it is undefined.
  assert.equal(helpers.pearson([1, 2, 3], [1, 2, 3]), 1)
  assert.equal(helpers.pearson([1, 2, 3], [2, 2, 2]), null)

  // The two-proportion test must refuse samples too small to mean anything,
  // rather than reporting a confident p-value on four users.
  assert.equal(helpers.twoProportionZTest(1, 3, 2, 4), null)
  const real = helpers.twoProportionZTest(60, 200, 30, 200)
  assert.ok(real && real.significant, 'a 30%-vs-15% split over 400 users should register as significant')
})

test('unavailable() states why a metric could not be computed', () => {
  const result = helpers.unavailable('no spend recorded')
  assert.equal(result.available, false)
  assert.equal(result.reason, 'no spend recorded')
})
