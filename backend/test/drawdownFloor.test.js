const test = require('node:test')
const assert = require('node:assert/strict')

const {
  resolveEffectiveFloor,
  getEffectiveDrawdownFloor,
  computeTrailingFloor,
  flushPeakEquityUpdates
} = require('../services/drawdownService')

// resolveEffectiveFloor is the pure half of the drawdown calculation, split out
// so the event-driven engine can evaluate a floor per tick without issuing the
// UPDATE that getEffectiveDrawdownFloor does. The split is only safe if the two
// agree exactly — the parity tests below are what guarantee the engine and the
// interval fallback cannot reach different verdicts about the same account.

function fakeDb() {
  const queries = []
  return {
    queries,
    async query(sql, values) {
      queries.push({ sql, values })
      return { rows: [], rowCount: 0 }
    }
  }
}

const CHALLENGE_ACCOUNT = {
  id: 'acc-1',
  starting_balance: 100000,
  eod_peak_equity: null,
  eod_trailing_floor: null,
  account_type: 'phase1'
}

const FUNDED_ACCOUNT = {
  id: 'acc-2',
  starting_balance: 100000,
  eod_peak_equity: null,
  eod_trailing_floor: null,
  account_type: 'funded'
}

test('the floor trails a new equity peak', () => {
  const resolved = resolveEffectiveFloor(CHALLENGE_ACCOUNT, { equity: 108000, maxDrawdownPct: 10 })

  assert.equal(resolved.nextPeak, 108000)
  assert.equal(resolved.peakChanged, true)
  assert.equal(resolved.floor, computeTrailingFloor(108000, 10))
  assert.equal(resolved.floor, 97200)
})

test('the floor holds at the previous peak when equity pulls back', () => {
  const account = { ...CHALLENGE_ACCOUNT, eod_peak_equity: 112000 }
  const resolved = resolveEffectiveFloor(account, { equity: 103000, maxDrawdownPct: 10 })

  assert.equal(resolved.nextPeak, 112000, 'peak never falls')
  assert.equal(resolved.peakChanged, false)
  assert.equal(resolved.floor, 100800)
})

test('an account with no recorded peak starts from its starting balance, not zero', () => {
  // A null eod_peak_equity treated as 0 would compute a floor of 0 and never
  // fail anyone; treated as starting_balance it behaves like an untouched account.
  const resolved = resolveEffectiveFloor(CHALLENGE_ACCOUNT, { equity: 95000, maxDrawdownPct: 10 })
  assert.equal(resolved.nextPeak, 100000)
  assert.equal(resolved.floor, 90000)
})

test('a non-funded account never locks a floor, whatever drawdownLocksAtPct says', () => {
  const resolved = resolveEffectiveFloor(CHALLENGE_ACCOUNT, {
    equity: 130000,
    maxDrawdownPct: 10,
    drawdownLocksAtPct: 5
  })
  assert.equal(resolved.lockedFloorChanged, false)
  assert.equal(resolved.floor, computeTrailingFloor(130000, 10))
})

test('a funded floor locks once peak equity crosses the threshold', () => {
  // Locks at +5% of a 100k account = 105000, so the locked floor is
  // 105000 * 0.9 = 94500.
  const resolved = resolveEffectiveFloor(FUNDED_ACCOUNT, {
    equity: 106000,
    maxDrawdownPct: 10,
    drawdownLocksAtPct: 5
  })

  assert.equal(resolved.lockedFloorChanged, true)
  assert.equal(resolved.nextLockedFloor, 94500)
  // The trailing floor (95400) is still higher here, and the higher of the two wins.
  assert.equal(resolved.floor, computeTrailingFloor(106000, 10))
})

test('a locked funded floor does not fall back when equity retreats', () => {
  const account = { ...FUNDED_ACCOUNT, eod_peak_equity: 106000, eod_trailing_floor: 94500 }
  const resolved = resolveEffectiveFloor(account, {
    equity: 96000,
    maxDrawdownPct: 10,
    drawdownLocksAtPct: 5
  })

  // Trailing would give 95400, but the lock holds the floor at 94500 — and the
  // higher of the two is what protects the trader here.
  assert.equal(resolved.floor, 95400)
  assert.equal(resolved.nextLockedFloor, 94500)
  assert.equal(resolved.lockedFloorChanged, false, 'an already-locked floor is not rewritten')
})

test('the locked floor wins once the trailing floor drops below it', () => {
  const account = { ...FUNDED_ACCOUNT, eod_peak_equity: 105000, eod_trailing_floor: 94500 }
  const resolved = resolveEffectiveFloor(account, {
    equity: 80000,
    maxDrawdownPct: 10,
    drawdownLocksAtPct: 5
  })

  assert.equal(resolved.floor, 94500, 'the lock, not the trailing calculation, sets the floor')
})

test('a funded account below the lock threshold behaves like a plain trailing account', () => {
  const resolved = resolveEffectiveFloor(FUNDED_ACCOUNT, {
    equity: 102000,
    maxDrawdownPct: 10,
    drawdownLocksAtPct: 5
  })
  assert.equal(resolved.lockedFloorChanged, false)
  assert.equal(resolved.nextLockedFloor, null)
  assert.equal(resolved.floor, computeTrailingFloor(102000, 10))
})

// ─── Parity with the persisting wrapper ──────────────────────────────────────

const PARITY_CASES = [
  ['fresh challenge account, new peak', CHALLENGE_ACCOUNT, { equity: 108000, maxDrawdownPct: 10 }],
  ['challenge account pulling back', { ...CHALLENGE_ACCOUNT, eod_peak_equity: 112000 }, { equity: 103000, maxDrawdownPct: 10 }],
  ['funded account crossing the lock', FUNDED_ACCOUNT, { equity: 106000, maxDrawdownPct: 10, drawdownLocksAtPct: 5 }],
  ['funded account already locked', { ...FUNDED_ACCOUNT, eod_peak_equity: 106000, eod_trailing_floor: 94500 }, { equity: 96000, maxDrawdownPct: 10, drawdownLocksAtPct: 5 }],
  ['funded account deep underwater', { ...FUNDED_ACCOUNT, eod_peak_equity: 105000, eod_trailing_floor: 94500 }, { equity: 80000, maxDrawdownPct: 10, drawdownLocksAtPct: 5 }],
  ['funded account below the lock threshold', FUNDED_ACCOUNT, { equity: 102000, maxDrawdownPct: 10, drawdownLocksAtPct: 5 }],
  ['string-typed columns from pg', { ...CHALLENGE_ACCOUNT, starting_balance: '100000', eod_peak_equity: '104000' }, { equity: 101000, maxDrawdownPct: 8 }],
]

test('the pure calculator returns the same floor as the persisting wrapper', async () => {
  for (const [label, account, opts] of PARITY_CASES) {
    const pure = resolveEffectiveFloor(account, opts)
    const persisted = await getEffectiveDrawdownFloor(fakeDb(), account, opts)
    assert.equal(persisted, pure.floor, `${label}: wrapper=${persisted} pure=${pure.floor}`)
  }
})

test('the wrapper writes only when something actually changed', async () => {
  const rising = fakeDb()
  await getEffectiveDrawdownFloor(rising, CHALLENGE_ACCOUNT, { equity: 108000, maxDrawdownPct: 10 })
  assert.equal(rising.queries.length, 1, 'one peak update on a new high')
  assert.match(rising.queries[0].sql, /eod_peak_equity/)

  const flat = fakeDb()
  await getEffectiveDrawdownFloor(flat, { ...CHALLENGE_ACCOUNT, eod_peak_equity: 112000 }, { equity: 103000, maxDrawdownPct: 10 })
  assert.equal(flat.queries.length, 0, 'no write when neither the peak nor the lock moved')
})

test('the wrapper writes both the peak and the lock when a funded floor first locks', async () => {
  const db = fakeDb()
  await getEffectiveDrawdownFloor(db, FUNDED_ACCOUNT, {
    equity: 106000,
    maxDrawdownPct: 10,
    drawdownLocksAtPct: 5
  })
  assert.equal(db.queries.length, 2)
  assert.match(db.queries[0].sql, /eod_peak_equity/)
  assert.match(db.queries[1].sql, /eod_trailing_floor/)
})

// ─── Bulk flush ──────────────────────────────────────────────────────────────

test('flushPeakEquityUpdates batches many accounts into a single statement', async () => {
  const db = fakeDb()
  const written = await flushPeakEquityUpdates(db, [
    { accountId: 'a', peak: 101000, lockedFloor: null },
    { accountId: 'b', peak: 102000, lockedFloor: 95000 },
    { accountId: 'c', peak: null, lockedFloor: 96000 }
  ])

  assert.equal(db.queries.length, 1, 'one statement regardless of account count')
  assert.deepEqual(db.queries[0].values[0], ['a', 'b', 'c'])
  assert.deepEqual(db.queries[0].values[1], [101000, 102000, null])
  assert.deepEqual(db.queries[0].values[2], [null, 95000, 96000])
  // The guards must only ever raise a floor, never lower one.
  assert.match(db.queries[0].sql, /GREATEST/)
  assert.equal(written, 0, 'fake db reports no rows touched')
})

test('flushPeakEquityUpdates issues no query for an empty or malformed batch', async () => {
  const db = fakeDb()
  assert.equal(await flushPeakEquityUpdates(db, []), 0)
  assert.equal(await flushPeakEquityUpdates(db, null), 0)
  assert.equal(await flushPeakEquityUpdates(db, [{ peak: 1 }]), 0, 'entries without an accountId are dropped')
  assert.equal(db.queries.length, 0)
})
