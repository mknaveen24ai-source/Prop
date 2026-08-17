const test = require('node:test')
const assert = require('node:assert/strict')

const priceCache = require('../utils/priceCache')
const socketRegistry = require('../services/socketRegistry')
const realtimeFanout = require('../services/realtimeFanout')

// The fan-out is what decides how many traders can be online at once, and it is
// the one part of the realtime path with no natural error signal: if it
// regresses to sending the full price map, nothing throws and nothing logs — the
// platform just quietly stops scaling. So the properties that make it cheap are
// asserted directly.

function price(bid, ask = bid + 0.0002) {
  return { bid, ask, updated_at: new Date(), age_ms: 0, stale: false }
}

/**
 * A minimal Socket.IO server double.
 *
 * Records room-targeted emits, whether `.volatile` was used, and whether the
 * emit was scoped with `.local`. Only the surface the fan-out actually touches —
 * `io.local.to(room).volatile.emit(...)` — is implemented, so a change that
 * reaches for anything else fails loudly here rather than being silently
 * accepted.
 *
 * `local` is modelled rather than ignored because dropping it is a real bug with
 * no local symptom: see the deliverPriceDelta comment, and the "exactly once"
 * test below.
 */
function fakeIo() {
  const emits = []
  const target = (room, local) => ({
    volatile: { emit: (event, payload) => emits.push({ room, event, payload, volatile: true, local }) },
    emit: (event, payload) => emits.push({ room, event, payload, volatile: false, local })
  })
  return {
    emits,
    local: { to: (room) => target(room, true) },
    to: (room) => target(room, false)
  }
}

function fakeSocket(userId) {
  const rooms = new Set()
  const emitted = []
  return {
    id: `socket-${userId}`,
    data: { userId },
    rooms,
    emitted,
    join: (room) => rooms.add(room),
    leave: (room) => rooms.delete(room),
    emit: (event, payload) => emitted.push({ event, payload, volatile: false }),
    volatile: { emit: (event, payload) => emitted.push({ event, payload, volatile: true }) }
  }
}

test.beforeEach(() => {
  realtimeFanout.__reset()
  socketRegistry.__reset()
  priceCache.__reset()
})

test.after(() => {
  realtimeFanout.__reset()
  socketRegistry.__reset()
  priceCache.__reset()
})

// ─── Price deltas ─────────────────────────────────────────────────────────────

test('a price broadcast carries only the instruments that moved', () => {
  const io = fakeIo()
  realtimeFanout.attach(io)

  priceCache.__setPricesForTest({
    EURUSD: price(1.1),
    GBPUSD: price(1.27),
    XAUUSD: price(2000),
    US500: price(5000)
  })

  realtimeFanout.queuePriceDelta(['EURUSD'])
  realtimeFanout.flushPrices()

  const combined = io.emits.find((e) => e.room === realtimeFanout.ALL_PRICES_ROOM)
  assert.ok(combined, 'expected a frame to the all-prices room')
  assert.deepEqual(
    Object.keys(combined.payload.p),
    ['EURUSD'],
    'the payload must not carry the three instruments that did not move'
  )
  assert.equal(typeof combined.payload.t, 'number', 'payload needs an emit timestamp')
})

test('price frames are volatile so a stalled client drops them instead of buffering', () => {
  const io = fakeIo()
  realtimeFanout.attach(io)
  priceCache.__setPricesForTest({ EURUSD: price(1.1) })

  realtimeFanout.queuePriceDelta(['EURUSD'])
  realtimeFanout.flushPrices()

  assert.ok(io.emits.length > 0)
  for (const emit of io.emits) {
    assert.equal(emit.volatile, true, `${emit.room} received a non-volatile price frame`)
  }
})

test('price frames are emitted .local so gateways do not re-deliver each other\'s frames', () => {
  // Regression guard for the fan-out amplification bug: flushPrices already
  // publishes on REDIS_PRICE_CHANNEL and every node delivers its own copy. A
  // plain io.to(room) ALSO hands the broadcast to the Socket.IO Redis adapter,
  // which republishes it to those same nodes — so with G gateways every browser
  // receives each frame G times and Redis carries G x (1 + instruments) extra
  // publishes per flush.
  //
  // There is no local symptom: a single instance behaves identically either way,
  // which is exactly why this needs a test rather than a comment.
  const io = fakeIo()
  realtimeFanout.attach(io)
  priceCache.__setPricesForTest({ EURUSD: price(1.1), XAUUSD: price(2000) })

  realtimeFanout.queuePriceDelta(['EURUSD', 'XAUUSD'])
  realtimeFanout.flushPrices()

  assert.ok(io.emits.length > 0)
  for (const emit of io.emits) {
    assert.equal(
      emit.local, true,
      `${emit.room} was emitted without .local — the Redis adapter will republish it to every other node`
    )
  }
})

test('the first tick goes out immediately and the rest of the window coalesces', () => {
  const io = fakeIo()
  realtimeFanout.attach(io)

  priceCache.__setPricesForTest({ EURUSD: price(1.1), XAUUSD: price(2000) })

  // Leading edge: after a quiet period the first tick must not wait for the
  // timer. Adding up to PRICE_BROADCAST_MS of latency to an otherwise idle feed
  // would make the dashboard feel worse than before this change, for nothing —
  // there is no fan-out cost to save when only one frame is in flight.
  realtimeFanout.queuePriceDelta(['EURUSD'])
  const immediate = io.emits.filter((e) => e.room === realtimeFanout.ALL_PRICES_ROOM)
  assert.equal(immediate.length, 1, 'the first tick after a quiet period must flush immediately')
  assert.equal(immediate[0].payload.p.EURUSD.bid, 1.1)

  // Everything after it inside the window is held and merged.
  realtimeFanout.queuePriceDelta(['XAUUSD'])
  realtimeFanout.queuePriceDelta(['EURUSD'])
  assert.equal(
    io.emits.filter((e) => e.room === realtimeFanout.ALL_PRICES_ROOM).length, 1,
    'further ticks inside the window must not each produce a frame'
  )

  // A newer EURUSD price arrives before the window closes: the held frame must
  // carry this one, not the value that was current when it was queued.
  priceCache.__setPricesForTest({ EURUSD: price(1.2), XAUUSD: price(2000) })
  realtimeFanout.flushPrices()

  const combined = io.emits.filter((e) => e.room === realtimeFanout.ALL_PRICES_ROOM)
  assert.equal(combined.length, 2, 'the coalesced remainder is one further frame')
  assert.deepEqual(Object.keys(combined[1].payload.p).sort(), ['EURUSD', 'XAUUSD'])
  assert.equal(combined[1].payload.p.EURUSD.bid, 1.2, 'coalescing must send the newest price, not the queued one')
})

test('a flush with nothing queued emits nothing', () => {
  const io = fakeIo()
  realtimeFanout.attach(io)
  realtimeFanout.flushPrices()
  assert.equal(io.emits.length, 0)
})

test('subscribers get their own instrument frame and leave the all-prices room', () => {
  const io = fakeIo()
  realtimeFanout.attach(io)
  const socket = fakeSocket('user-1')
  socket.join(realtimeFanout.ALL_PRICES_ROOM)

  realtimeFanout.setSocketSubscriptions(socket, ['eurusd', 'XAUUSD'])

  assert.ok(socket.rooms.has(`${realtimeFanout.PRICE_ROOM_PREFIX}EURUSD`), 'symbols must be normalised to upper case')
  assert.ok(socket.rooms.has(`${realtimeFanout.PRICE_ROOM_PREFIX}XAUUSD`))
  assert.equal(
    socket.rooms.has(realtimeFanout.ALL_PRICES_ROOM), false,
    'a subscriber left in the all-prices room would receive both frames and save nothing'
  )

  priceCache.__setPricesForTest({ EURUSD: price(1.1), XAUUSD: price(2000) })
  realtimeFanout.queuePriceDelta(['EURUSD'])
  realtimeFanout.flushPrices()

  const perInstrument = io.emits.find((e) => e.room === `${realtimeFanout.PRICE_ROOM_PREFIX}EURUSD`)
  assert.ok(perInstrument, 'expected a frame to the EURUSD room')
  assert.deepEqual(Object.keys(perInstrument.payload.p), ['EURUSD'])
})

test('clearing a subscription restores the full feed rather than silencing it', () => {
  const socket = fakeSocket('user-1')
  realtimeFanout.setSocketSubscriptions(socket, ['EURUSD'])
  realtimeFanout.setSocketSubscriptions(socket, [])

  assert.equal(socket.rooms.has(`${realtimeFanout.PRICE_ROOM_PREFIX}EURUSD`), false)
  assert.ok(
    socket.rooms.has(realtimeFanout.ALL_PRICES_ROOM),
    'an empty watchlist must not leave the trader with no prices at all'
  )
})

test('a subscription list is capped so one client cannot join unbounded rooms', () => {
  const socket = fakeSocket('user-1')
  const huge = Array.from({ length: realtimeFanout.MAX_SUBSCRIPTIONS + 50 }, (_, i) => `SYM${i}`)

  const result = realtimeFanout.setSocketSubscriptions(socket, huge)

  assert.equal(result.subscribed, realtimeFanout.MAX_SUBSCRIPTIONS)
  assert.equal(socket.rooms.size, realtimeFanout.MAX_SUBSCRIPTIONS)
})

// ─── Equity batching ──────────────────────────────────────────────────────────

function snapshot(accountId, userId, overrides = {}) {
  return {
    accountId,
    userId,
    equity: 101000,
    floatingPnl: 1000,
    currentBalance: 100000,
    floor: 90000,
    startingBalance: 100000,
    profitTarget: 10000,
    accountType: 'phase1',
    dailyLossPct: 0,
    dailyDrawdownPct: null,
    ...overrides
  }
}

test('equity snapshots reach only the sockets belonging to that user', () => {
  realtimeFanout.attach(fakeIo())
  const mine = fakeSocket('user-1')
  const theirs = fakeSocket('user-2')
  socketRegistry.register(mine)
  socketRegistry.register(theirs)

  realtimeFanout.queueEquityUpdates([snapshot('acc-1', 'user-1')])

  assert.equal(mine.emitted.length, 1)
  assert.equal(mine.emitted[0].event, 'equity_update')
  assert.equal(mine.emitted[0].payload.account_id, 'acc-1')
  assert.equal(theirs.emitted.length, 0, 'another trader must never receive this account')
})

test('every open tab for a user receives the snapshot', () => {
  realtimeFanout.attach(fakeIo())
  const tabOne = fakeSocket('user-1')
  const tabTwo = { ...fakeSocket('user-1'), id: 'socket-user-1-b' }
  socketRegistry.register(tabOne)
  socketRegistry.register(tabTwo)

  realtimeFanout.queueEquityUpdates([snapshot('acc-1', 'user-1')])

  assert.equal(tabOne.emitted.length, 1)
  assert.equal(tabTwo.emitted.length, 1)
})

test('a second snapshot for the same account inside the throttle window is dropped', () => {
  realtimeFanout.attach(fakeIo())
  const socket = fakeSocket('user-1')
  socketRegistry.register(socket)

  realtimeFanout.queueEquityUpdates([snapshot('acc-1', 'user-1', { equity: 101000 })])
  realtimeFanout.queueEquityUpdates([snapshot('acc-1', 'user-1', { equity: 102000 })])

  assert.equal(socket.emitted.length, 1, 'the throttle must hold at one push per account per window')
  assert.equal(socket.emitted[0].payload.equity, 101000)
})

test('a disconnected socket stops receiving and is removed from the registry', () => {
  realtimeFanout.attach(fakeIo())
  const socket = fakeSocket('user-1')
  socketRegistry.register(socket)
  assert.equal(socketRegistry.getUserCount(), 1)

  socketRegistry.unregister(socket)

  assert.equal(socketRegistry.getUserCount(), 0, 'an empty user entry must be dropped, not left behind')
  realtimeFanout.queueEquityUpdates([snapshot('acc-1', 'user-1')])
  assert.equal(socket.emitted.length, 0)
})

test('an equity batch for users on another node is discarded without error', () => {
  realtimeFanout.attach(fakeIo())
  const local = fakeSocket('user-1')
  socketRegistry.register(local)

  // What a gateway receives over Redis: every recipient platform-wide, most of
  // whom are connected elsewhere.
  realtimeFanout.deliverEquityBatch([
    { userId: 'user-1', payload: { account_id: 'acc-1' } },
    { userId: 'user-99', payload: { account_id: 'acc-99' } }
  ])

  assert.equal(local.emitted.length, 1)
  assert.equal(local.emitted[0].payload.account_id, 'acc-1')
})

test('equity pushes are volatile — a stale number is worth less than the next one', () => {
  realtimeFanout.attach(fakeIo())
  const socket = fakeSocket('user-1')
  socketRegistry.register(socket)

  realtimeFanout.queueEquityUpdates([snapshot('acc-1', 'user-1')])

  assert.equal(socket.emitted[0].volatile, true)
})

test('local delivery happens once, not once per transport', () => {
  realtimeFanout.attach(fakeIo())
  const socket = fakeSocket('user-1')
  socketRegistry.register(socket)

  // ROLE=all delivers to its own sockets AND publishes for sibling instances.
  // If the subscriber did not filter on origin, this process would receive its
  // own publish back and every trader would see each snapshot twice — which
  // shows up as a flickering equity readout and nothing in any log.
  realtimeFanout.queueEquityUpdates([snapshot('acc-1', 'user-1')])

  assert.equal(socket.emitted.length, 1, 'a snapshot must be delivered exactly once')
})

test('the payload keeps the field names the dashboard already reads', () => {
  realtimeFanout.attach(fakeIo())
  const socket = fakeSocket('user-1')
  socketRegistry.register(socket)

  realtimeFanout.queueEquityUpdates([snapshot('acc-1', 'user-1')])

  const payload = socket.emitted[0].payload
  for (const field of [
    'account_id', 'equity', 'floating_pnl', 'current_balance', 'drawdown_floor',
    'drawdown_used_pct', 'daily_drawdown_used_pct', 'daily_drawdown_limit_pct', 'profit_remaining'
  ]) {
    assert.ok(field in payload, `missing ${field} — the dashboard reads this by name`)
  }
})

test('a large equity batch is published in bounded chunks, not one oversized message', async () => {
  // Redis pub/sub enforces client-output-buffer-limit (8mb over 60s soft by
  // default). A subscriber fed repeated multi-megabyte messages is disconnected
  // BY REDIS, and the only symptom is equity quietly freezing on that gateway.
  // So the peak message size has to stay bounded even when one tick touches
  // every account on the platform.
  const io = fakeIo()
  realtimeFanout.attach(io)

  const published = []
  await realtimeFanout.__setPublisherForTest({
    publish: async (channel, raw) => { published.push({ channel, raw }); return 1 }
  })

  try {
    const snapshots = []
    for (let i = 0; i < 1200; i++) {
      snapshots.push({
        accountId: `acc-${i}`,
        userId: `user-${i}`,
        equity: 100000,
        floatingPnl: 0,
        currentBalance: 100000,
        floor: 90000,
        startingBalance: 100000,
        profitTarget: 10000,
        accountType: 'phase1',
        dailyLossPct: 0,
        dailyDrawdownPct: 5
      })
    }
    realtimeFanout.queueEquityUpdates(snapshots)

    assert.ok(published.length > 1, 'a 1200-account batch must not go out as one message')

    let totalDelivered = 0
    for (const message of published) {
      const entries = JSON.parse(message.raw).message
      assert.ok(
        entries.length <= realtimeFanout.MAX_EQUITY_BATCH,
        `chunk of ${entries.length} exceeds the ${realtimeFanout.MAX_EQUITY_BATCH} cap`
      )
      totalDelivered += entries.length
    }
    assert.equal(totalDelivered, 1200, 'chunking must not drop or duplicate a single recipient')
  } finally {
    await realtimeFanout.__setPublisherForTest(null)
  }
})
