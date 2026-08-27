import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import screenshotRouter = require('../routes/trades/screenshots')
import tradeRouteShared = require('../routes/trades/shared')
import tradeShared = require('../services/tradeShared')

void test('trade screenshot data URLs retain the existing PNG and JPEG allowlist', () => {
  assert.equal(tradeRouteShared.isValidImageDataUrl('data:image/png;base64,aGVsbG8='), true)
  assert.equal(tradeRouteShared.isValidImageDataUrl(' data:image/jpeg;base64,aGVsbG8= '), true)
  assert.equal(tradeRouteShared.isValidImageDataUrl('data:image/gif;base64,aGVsbG8='), false)
  assert.equal(tradeRouteShared.isValidImageDataUrl('https://example.test/image.png'), false)
  assert.equal(tradeRouteShared.isValidImageDataUrl({ data: 'image' }), false)
})

void test('trade screenshot path resolution stays under the configured upload root', () => {
  const resolved = tradeRouteShared.buildTradeScreenshotAbsolutePath('user-1/trade-1-open-1.png')
  assert.equal(
    resolved,
    path.join(tradeShared.TRADE_JOURNAL_UPLOAD_ROOT, 'user-1', 'trade-1-open-1.png')
  )
  assert.equal(tradeRouteShared.buildTradeScreenshotAbsolutePath('../outside.png'), null)
  assert.equal(tradeRouteShared.buildTradeScreenshotAbsolutePath(null), null)
})

void test('invalid screenshot input is rejected before any filesystem write', async () => {
  assert.equal(await tradeRouteShared.persistTradeScreenshot({
    tradeId: 'trade-1',
    userId: 'user-1',
    kind: 'open',
    dataUrl: 'not-an-image'
  }), null)
})

void test('screenshot route preserves authentication and handler order', () => {
  const stack = (screenshotRouter as unknown as {
    stack: Array<{
      route?: {
        path: string
        stack: Array<{ name: string }>
      }
    }>
  }).stack
  const route = stack.find((layer) => layer.route?.path === '/:tradeId/screenshot/:kind')
  assert.ok(route)
  assert.deepEqual(route.route?.stack.map((handler) => handler.name), [
    'authenticateToken',
    'screenshotHandler'
  ])
})
