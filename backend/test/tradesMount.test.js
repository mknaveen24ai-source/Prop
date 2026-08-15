const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const express = require('express')
const request = require('supertest')
require('../loadEnv')
const { router: tradesRouter } = require('../routes/trades')

// Guards the routes/trades/ split against its one silent failure mode: a module
// that is written, imported by nothing, and therefore never mounted. Its routes
// simply 404, and every other test in this suite would still pass because they
// exercise handlers directly rather than through the assembled router.
//
// No database or auth setup is needed. Every trades route sits behind
// authenticateToken, so an unauthenticated request separates the two cases
// cleanly: 401 means the route is mounted and the guard ran, 404 means the route
// is not there at all.

const app = express()
app.use(express.json())
app.use('/api/trades', tradesRouter)

// One route per module, so a whole module going missing is caught.
const ROUTES = [
  ['charts',      'get',   '/api/trades/candles'],
  ['open',        'post',  '/api/trades/open'],
  ['close',       'post',  '/api/trades/close'],
  ['close',       'post',  '/api/trades/cancel'],
  ['modify',      'patch', '/api/trades/modify-pending'],
  ['modify',      'patch', '/api/trades/modify'],
  ['history',     'get',   '/api/trades/open'],
  ['history',     'get',   '/api/trades/pending'],
  ['history',     'get',   '/api/trades/history'],
  ['history',     'get',   '/api/trades/export'],
  ['analytics',   'get',   '/api/trades/analytics'],
  ['batch',       'post',  '/api/trades/batch-action'],
  ['screenshots', 'get',   '/api/trades/abc123/screenshot/open']
]

for (const [module, method, url] of ROUTES) {
  test(`${method.toUpperCase()} ${url} is mounted (from ${module}.js)`, async () => {
    const res = await request(app)[method](url).send({})
    assert.notEqual(res.status, 404, `${url} is not mounted — check routes/trades/index.js`)
    assert.equal(res.status, 401, `${url} should reject an unauthenticated caller`)
  })
}

test('an unknown trades path still 404s, so the check above means something', () => {
  // Without this, a catch-all would make every assertion above pass vacuously.
  return request(app).get('/api/trades/definitely-not-a-route').expect(404)
})

test('every module in routes/trades/ is mounted by index.js', () => {
  // The list above is hand-maintained; this is not. A new module added to the
  // directory but never mounted fails here even if nobody updates ROUTES.
  const dir = path.join(__dirname, '..', 'routes', 'trades')
  const modules = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js'))
    .map((f) => f.replace(/\.js$/, ''))
    .filter((name) => name !== 'index' && name !== 'shared') // shared.js exports helpers, not a router

  const indexSource = fs.readFileSync(path.join(dir, 'index.js'), 'utf8')
  const unmounted = modules.filter((name) => !indexSource.includes(`require('./${name}')`))

  assert.deepEqual(unmounted, [], `routes/trades/index.js never mounts: ${unmounted.join(', ')}`)
})

test('the assembled router exposes exactly the pre-split route table', () => {
  // Locks the split's acceptance criterion in place. Captured from
  // routes/trades.js before it was split; scripts/route-manifest.js prints
  // this same list. Method, path, ORDER and middleware depth all matter — a
  // dropped authenticateToken shows up here as a [2] that should be [3].
  const expected = [
    'get /candles [2]',
    'post /open [3]',
    'post /close [3]',
    'post /cancel [3]',
    'patch /modify-pending [3]',
    'patch /modify [3]',
    'get /open [2]',
    'get /pending [2]',
    'get /history [2]',
    'get /export [2]',
    'get /analytics [2]',
    'post /batch-action [3]',
    'get /:tradeId/screenshot/:kind [2]'
  ]

  const actual = []
  const visit = (stack) => {
    ;(stack || []).forEach((layer) => {
      if (layer.route) {
        const methods = Object.keys(layer.route.methods).sort().join(',')
        actual.push(`${methods} ${layer.route.path} [${layer.route.stack.length}]`)
      } else if (layer.handle && layer.handle.stack) {
        visit(layer.handle.stack)
      }
    })
  }
  visit(tradesRouter.stack)

  assert.deepEqual(actual, expected)
})
