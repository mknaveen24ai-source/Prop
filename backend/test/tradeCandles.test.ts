import assert from 'node:assert/strict'
import test from 'node:test'
import tradeCandles = require('../utils/tradeCandles')

void test('normalizes PostgreSQL candle values without changing the chart wire format', () => {
  assert.deepEqual(tradeCandles.normalizeCandleRows([
    {
      time: '1720000000',
      open: '1.10001',
      high: '1.10009',
      low: '1.09991',
      close: '1.10004',
      volume: '17'
    }
  ]), [
    {
      time: 1720000000,
      open: 1.10001,
      high: 1.10009,
      low: 1.09991,
      close: 1.10004,
      volume: 17
    }
  ])
})

void test('drops malformed price rows and preserves a malformed volume as zero', () => {
  assert.deepEqual(tradeCandles.normalizeCandleRows([
    { time: '1', open: 'bad', high: '2', low: '1', close: '2', volume: '5' },
    { time: '2', open: '1', high: '2', low: '1', close: '2', volume: 'bad' }
  ]), [
    { time: 2, open: 1, high: 2, low: 1, close: 2, volume: 0 }
  ])
})

void test('caches candles by key and keeps the existing lookback bounds', () => {
  const key = `trade-candles-test-${Date.now()}`
  const candles = [{ time: 1, open: 1, high: 2, low: 0.5, close: 1.5, volume: 3 }]
  assert.equal(tradeCandles.getCachedCandles(key), null)
  tradeCandles.setCachedCandles(key, candles)
  assert.deepEqual(tradeCandles.getCachedCandles(key), candles)

  assert.equal(tradeCandles.getRawCandleLookbackDays(1, 90), 3)
  assert.equal(tradeCandles.getRawCandleLookbackDays(240, 90), 90)
  assert.equal(tradeCandles.getRawCandleLookbackDays(0, 0), 1)
})
