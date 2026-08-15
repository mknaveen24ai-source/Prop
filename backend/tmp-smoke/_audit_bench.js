// Micro-benchmark of the pure hot-path functions. No DB/Redis needed.
const { performance } = require('perf_hooks')
const { fastPnL, DIRECTION_BUY, isSLTriggered, isPendingTriggered } = require('../utils/fastPnL')
const { calculatePnL } = require('../utils/pnlCalculator')

function bench(name, fn, iters) {
  fn(); // warm
  for (let i = 0; i < Math.min(iters, 50000); i++) fn()
  const t0 = performance.now()
  for (let i = 0; i < iters; i++) fn()
  const t1 = performance.now()
  const totalMs = t1 - t0
  console.log(
    name.padEnd(42),
    'total ' + totalMs.toFixed(1).padStart(8) + 'ms',
    '| per-call ' + ((totalMs / iters) * 1000).toFixed(3).padStart(8) + 'µs'
  )
  return totalMs / iters
}

const N = 1_000_000
console.log('iterations per bench: ' + N.toLocaleString() + '\n')
const fastNs = bench('fastPnL (native float)', () => fastPnL(DIRECTION_BUY, 1.1000, 1.1050, 1.0, 100000, 3), N)
const decNs  = bench('calculatePnL (Decimal.js)', () => calculatePnL('buy', 1.1000, 1.1050, 1.0, 'EURUSD', 3), 200000)
bench('isSLTriggered', () => isSLTriggered(DIRECTION_BUY, 1.09, 1.1050), N)
bench('isPendingTriggered', () => isPendingTriggered('buy_limit', 1.09, { bid: 1.1, ask: 1.1001 }), N)

console.log('\nDecimal is ' + (decNs / fastNs).toFixed(0) + 'x slower than the float path.')
console.log('\n--- Projected full-scan cost (single instrument tick, all trades on it) ---')
for (const n of [1000, 10000, 100000]) {
  console.log(
    ('  ' + n.toLocaleString() + ' open trades').padEnd(28) +
    'float scan ~' + (fastNs * n).toFixed(1).padStart(8) + 'ms' +
    '   |  Decimal-only scan ~' + (decNs * n).toFixed(1).padStart(9) + 'ms'
  )
}
