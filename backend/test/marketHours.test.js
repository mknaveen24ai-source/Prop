const test = require('node:test')
const assert = require('node:assert/strict')

const { getMarketStatus } = require('../routes/trades')
const pool = require('../db')

test('open mode blocks new trades after Friday 21:00 UTC', () => {
  const status = getMarketStatus('EURUSD', {
    purpose: 'open',
    now: new Date('2026-04-17T21:00:00.000Z')
  })

  assert.equal(status.open, false)
  assert.match(status.reason, /Friday 21:00 UTC/i)
})

test('close mode still allows closes before Friday market close', () => {
  const status = getMarketStatus('EURUSD', {
    purpose: 'close',
    now: new Date('2026-04-17T21:10:00.000Z')
  })

  assert.equal(status.open, true)
})

test('close mode blocks during Friday rollover window', () => {
  const status = getMarketStatus('EURUSD', {
    purpose: 'close',
    now: new Date('2026-04-17T21:58:00.000Z')
  })

  assert.equal(status.open, false)
  assert.match(status.reason, /rollover/i)
})

test.after(async () => {
  await pool.end()
})
