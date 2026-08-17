'use strict'
/**
 * Realtime fan-out
 * ─────────────────────────────────────────────────────────────────────────────
 * Owns everything the engine sends to browsers. Extracted from priceBroadcast.js
 * because the broadcast is now the scaling constraint, not an afterthought of
 * the tick.
 *
 * ── The problem this solves ──
 *
 * The old path was one line:
 *
 *     io.emit('price_update', priceCache.getAllPrices())
 *
 * That sends the FULL price map — every instrument, whether it moved or not — to
 * EVERY connected socket, on every tick. The cost is
 *
 *     payload_size × sockets × ticks_per_second
 *
 * and only the first term is under our control. At ~6KB for the full map and
 * 10,000 sockets that is 60 MB/s out of a single Node process, which is not a
 * tuning problem — it is a "this cannot work" problem. Three changes fix it:
 *
 *   1. DELTAS. Send only instruments whose bid or ask actually moved.
 *      priceCache.updatePrices() already returns exactly that list, so this
 *      costs nothing to compute. A typical tick moves 1-3 of 45 instruments:
 *      ~6KB becomes ~300 bytes.
 *
 *   2. CADENCE CAP. Coalesce broadcasts to at most one per PRICE_BROADCAST_MS.
 *      **The engine still runs on every tick** — that is what keeps SL/TP
 *      reaction at 50-80ms, and it is untouched by anything in this file. This
 *      caps only what browsers are sent. No trader's eye needs 20 price frames a
 *      second; their stop-loss does need every one, and still gets it.
 *
 *   3. SUBSCRIPTIONS. A client that calls `subscribe_instruments` receives only
 *      the instruments it asked for, via per-instrument rooms. A trader watching
 *      one chart stops paying for the other 44.
 *
 * ── Payload shape ──
 *
 *     { t: <emit epoch ms>, p: { EURUSD: {bid, ask, ...}, ... } }
 *
 * Deliberately the same shape for both the combined and the per-instrument
 * frame, so the client has one merge path rather than three. `t` also gives the
 * socket load harness a real emit-to-receipt latency to measure.
 *
 * ── Cross-process delivery ──
 *
 * Under ROLE=engine the sockets are on other machines. Rather than let the
 * Socket.IO Redis adapter turn every per-user emit into its own publish, the
 * engine publishes ONE batched message per flush and gateways deliver locally
 * (services/socketRegistry.js). One publish per tick, not one per recipient.
 */

const logger = require('../utils/logger')
const role = require('../config/role')
const priceCache = require('../utils/priceCache')
const socketRegistry = require('./socketRegistry')
const { getRedisClient } = require('../utils/tokenCache')

// ─── Tunables ─────────────────────────────────────────────────────────────────
/**
 * Ceiling on how often browsers are sent prices. 250ms (4/s) is well inside what
 * reads as "live" and bounds fan-out cost independently of how fast the feed
 * ticks — which matters because the DWX file can change far more often than
 * anyone can perceive.
 */
const PRICE_BROADCAST_MS = Math.max(
  0,
  parseInt(process.env.PRICE_BROADCAST_MS || '250', 10) || 250
)

/** Per-account equity push throttle. Preserved from the original pushEquityUpdates. */
const EQUITY_PUSH_INTERVAL_MS = Math.max(
  0,
  parseInt(process.env.EQUITY_PUSH_INTERVAL_MS || '500', 10) || 500
)

/** How many instruments a single client may subscribe to. */
const MAX_SUBSCRIPTIONS = 60

/**
 * Recipients per published equity message.
 *
 * The batch itself is unbounded by design — one tick touches every account whose
 * numbers moved, and at 10K active accounts that is a single message carrying
 * 10K payloads, on the order of a megabyte or two of JSON.
 *
 * That is a problem for Redis before it is a problem for CPU. Pub/sub delivery is
 * governed by client-output-buffer-limit, which defaults to 32mb hard and 8mb
 * over 60s soft: a subscriber fed repeated multi-megabyte messages hits the soft
 * limit and is DISCONNECTED BY REDIS. The gateway then silently stops receiving
 * equity — no error on either side, traders just see a frozen number.
 *
 * Chunking bounds each message instead. Total bytes are unchanged; the peak is
 * what matters. 500 payloads is roughly 50-100KB per message.
 */
const MAX_EQUITY_BATCH = Math.max(
  1,
  parseInt(process.env.EQUITY_BATCH_MAX || '500', 10) || 500
)

const PRICE_ROOM_PREFIX = 'price:'
/** Clients that never call subscribe_instruments stay here and get everything. */
const ALL_PRICES_ROOM = 'prices'

const REDIS_PRICE_CHANNEL = 'rt:price'
const REDIS_EQUITY_CHANNEL = 'rt:equity'

/**
 * Identifies messages this process published, so it can ignore its own.
 *
 * Needed because ROLE=all both publishes and subscribes. It delivers locally
 * first (no Redis hop for its own traders) and publishes for any sibling
 * instance — and without this it would then receive that publish back and
 * deliver everything a second time.
 */
const INSTANCE_ID = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

// ─── State ────────────────────────────────────────────────────────────────────
let _io = null
let _pendingInstruments = new Set()
let _priceFlushTimer = null
let _lastPriceFlushAt = 0

const _pendingEquity = new Map()   // accountId → snapshot (latest wins)
const _lastEquityPushAt = new Map()

let _redisPublisher = null
let _redisSubscriber = null

// Counters, surfaced through getFanoutStats() so the effect of all of this is
// observable rather than asserted.
const _stats = {
  priceFlushes: 0,
  priceFramesEmitted: 0,
  priceInstrumentsEmitted: 0,
  equityBatches: 0,
  equitySnapshotsEmitted: 0,
  equitySnapshotsThrottled: 0
}

function attach(io) {
  _io = io
}

// ─── Price fan-out ────────────────────────────────────────────────────────────
/**
 * Queue instruments for the next browser broadcast.
 *
 * Coalescing rather than emitting immediately is the point: ten ticks inside one
 * PRICE_BROADCAST_MS window become one frame carrying the newest price for each
 * instrument, not ten frames of which nine are already stale on arrival.
 */
function queuePriceDelta(instruments) {
  if (!instruments || instruments.length === 0) return
  for (const instrument of instruments) _pendingInstruments.add(instrument)

  if (_priceFlushTimer) return

  const sinceLast = Date.now() - _lastPriceFlushAt
  const wait = Math.max(0, PRICE_BROADCAST_MS - sinceLast)
  if (wait === 0) { flushPrices(); return }

  _priceFlushTimer = setTimeout(() => {
    _priceFlushTimer = null
    flushPrices()
  }, wait)
  // Never hold the process open for a pending price frame.
  if (typeof _priceFlushTimer.unref === 'function') _priceFlushTimer.unref()
}

function buildPriceDelta(instruments) {
  const p = {}
  for (const instrument of instruments) {
    const price = priceCache.getPrice(instrument)
    if (price) p[instrument] = price
  }
  return { t: Date.now(), p }
}

function flushPrices() {
  if (_pendingInstruments.size === 0) return
  const instruments = Array.from(_pendingInstruments)
  _pendingInstruments = new Set()
  _lastPriceFlushAt = Date.now()
  _stats.priceFlushes++

  const delta = buildPriceDelta(instruments)
  if (Object.keys(delta.p).length === 0) return

  // Local sockets first — under ROLE=all there is no reason to make this
  // process's own traders wait for a Redis round trip. ROLE=engine has no local
  // sockets, so this is a no-op there.
  if (!role.publishesRealtimeOverRedis()) deliverPriceDelta(delta)
  publish(REDIS_PRICE_CHANNEL, delta)
}

/**
 * Write a delta to local sockets.
 *
 * Two audiences, both sent deltas:
 *   - the ALL_PRICES_ROOM gets one combined frame (clients that never called
 *     subscribe_instruments — every client today);
 *   - per-instrument rooms get one frame each, so a subscriber pays only for
 *     what it asked for.
 *
 * Volatile on purpose. A client whose connection is backed up should skip this
 * frame, not queue it: the next one is 250ms away and strictly better. Without
 * volatile, one stalled mobile client accumulates an unbounded write buffer,
 * which at 10K sockets is how a gateway runs out of memory.
 *
 * ── .local is load-bearing ──
 *
 * Every caller of this function has ALREADY arranged cross-node delivery:
 * flushPrices and broadcastSnapshot publish on REDIS_PRICE_CHANNEL, and the
 * subscriber calls this on each node that receives it. A plain `_io.to(room)`
 * hands the same broadcast to the Socket.IO Redis adapter as well
 * (services/socketService.js attaches it whenever Redis is available), which
 * republishes it to every other node — and those nodes then deliver a copy of a
 * frame they already delivered from REDIS_PRICE_CHANNEL themselves.
 *
 * With G gateways that is every frame delivered G times to every browser, plus
 * G x (1 + instruments) adapter publishes per flush on top of the one this
 * module makes. The INSTANCE_ID origin guard in unwrap() cannot catch it,
 * because the duplicate arrives over the adapter's channel, not ours.
 *
 * `.local` restricts the emit to sockets on THIS node, which is exactly the
 * contract every caller already assumes. Invisible on a single instance; it
 * appears the moment a second gateway joins.
 */
function deliverPriceDelta(delta) {
  if (!_io) return
  const instruments = Object.keys(delta.p)

  _io.local.to(ALL_PRICES_ROOM).volatile.emit('price_update', delta)
  _stats.priceFramesEmitted++
  _stats.priceInstrumentsEmitted += instruments.length

  for (const instrument of instruments) {
    _io.local.to(PRICE_ROOM_PREFIX + instrument).volatile.emit('price_update', {
      t: delta.t,
      p: { [instrument]: delta.p[instrument] }
    })
    _stats.priceFramesEmitted++
  }
}

/**
 * Broadcast a complete price map immediately, bypassing the coalescing timer.
 *
 * For the dedicated-tenant-feed path, which produces a whole map rather than a
 * changed-instrument list and runs on a 30s cadence — far too rare for the
 * coalescing above to be worth anything. Same payload shape as a delta, so the
 * client still has exactly one merge path.
 */
function broadcastSnapshot(priceMap) {
  if (!priceMap || typeof priceMap !== 'object') return
  const delta = { t: Date.now(), p: priceMap }
  if (!role.publishesRealtimeOverRedis()) deliverPriceDelta(delta)
  publish(REDIS_PRICE_CHANNEL, delta)
}

/**
 * Move a socket from "everything" to a specific instrument set.
 *
 * Called from the socket connection handler. Leaving ALL_PRICES_ROOM is what
 * actually saves the bytes — a subscriber that stayed in it would receive both
 * the combined frame and its per-instrument frames.
 *
 * ── Nothing in the current UI calls this, on purpose ──
 *
 * The trading page's watchlist rail renders every available instrument by
 * default (components/trading/hooks/useWatchlist.js — `tickerInstruments`
 * is the full list when the category filter is 'all'), so a trader on that page
 * genuinely needs all 45 and subscribing would save nothing while risking blank
 * rows. The saving is real for surfaces that show a handful — the mobile
 * terminal, a dashboard with no watchlist — which is why the server side exists
 * now rather than later. Wire it from a client only once that client can name
 * its complete instrument set; a partial set is silently missing prices, which
 * is a worse bug than a large payload.
 */
function setSocketSubscriptions(socket, instruments) {
  if (!socket) return { subscribed: 0 }

  const requested = Array.isArray(instruments) ? instruments : []
  const next = new Set()
  for (const raw of requested) {
    const instrument = String(raw || '').trim().toUpperCase()
    if (!instrument) continue
    next.add(instrument)
    if (next.size >= MAX_SUBSCRIPTIONS) break
  }

  const previous = socket.data._priceRooms || new Set()
  for (const instrument of previous) {
    if (!next.has(instrument)) socket.leave(PRICE_ROOM_PREFIX + instrument)
  }
  for (const instrument of next) {
    if (!previous.has(instrument)) socket.join(PRICE_ROOM_PREFIX + instrument)
  }
  socket.data._priceRooms = next

  // An empty subscription means "go back to everything" rather than "silence" —
  // a client clearing its watchlist should not lose its price feed.
  if (next.size === 0) socket.join(ALL_PRICES_ROOM)
  else socket.leave(ALL_PRICES_ROOM)

  return { subscribed: next.size }
}

// ─── Equity fan-out ───────────────────────────────────────────────────────────
/**
 * Queue equity snapshots produced by an engine tick.
 *
 * The per-account throttle is applied here, at queue time, so a throttled
 * snapshot costs one map lookup instead of a socket write. Latest-wins: if two
 * ticks land inside one flush window the newer number replaces the older, which
 * is the only one worth sending.
 */
function queueEquityUpdates(snapshots) {
  if (!snapshots || snapshots.length === 0) return
  const now = Date.now()

  for (const snapshot of snapshots) {
    const lastPush = _lastEquityPushAt.get(snapshot.accountId) || 0
    if ((now - lastPush) < EQUITY_PUSH_INTERVAL_MS) {
      _stats.equitySnapshotsThrottled++
      continue
    }
    _lastEquityPushAt.set(snapshot.accountId, now)
    _pendingEquity.set(snapshot.accountId, snapshot)
  }

  // Bound the throttle map — accounts churn as challenges pass and fail.
  if (_lastEquityPushAt.size > 50000) {
    for (const [accountId, at] of _lastEquityPushAt) {
      if ((now - at) > 60000) _lastEquityPushAt.delete(accountId)
    }
  }

  flushEquity()
}

function toEquityPayload(snapshot) {
  const drawdownUsedPct = snapshot.startingBalance > 0
    ? ((snapshot.startingBalance - snapshot.equity) / snapshot.startingBalance) * 100
    : 0
  const profitTarget = snapshot.profitTarget > 0
    ? snapshot.profitTarget
    : snapshot.startingBalance * 0.10

  return {
    account_id: snapshot.accountId,
    equity: snapshot.equity,
    floating_pnl: snapshot.floatingPnl,
    current_balance: snapshot.currentBalance,
    drawdown_floor: snapshot.floor,
    drawdown_used_pct: Math.max(0, drawdownUsedPct),
    daily_drawdown_used_pct: snapshot.dailyLossPct,
    daily_drawdown_limit_pct: snapshot.dailyDrawdownPct,
    profit_remaining: Math.max(0, profitTarget - (snapshot.equity - snapshot.startingBalance))
  }
}

function flushEquity() {
  if (_pendingEquity.size === 0) return

  const batch = []
  for (const snapshot of _pendingEquity.values()) {
    batch.push({ userId: String(snapshot.userId), payload: toEquityPayload(snapshot) })
  }
  _pendingEquity.clear()
  _stats.equityBatches++

  if (!role.publishesRealtimeOverRedis()) deliverEquityBatch(batch)

  // A publish per CHUNK, not per recipient — still nothing like the old
  // per-recipient emit, which was ~13K Redis operations a second at 100K
  // positions. One tick at 10K accounts is 20 messages here rather than one
  // oversized one; see MAX_EQUITY_BATCH for why the peak message size is the
  // thing that actually breaks.
  //
  // Published even under ROLE=all, and this is not optional: these snapshots
  // used to go out as `io.to(userId).emit(...)`, which the Socket.IO Redis
  // adapter carried to sibling instances. Delivering only to local sockets
  // without publishing would silently strip live equity from every trader
  // connected to a different replica of a scaled `all` deployment.
  //
  // publish() returns before serialising when no publisher is connected, so the
  // single-instance no-Redis case pays nothing for any of this.
  for (let offset = 0; offset < batch.length; offset += MAX_EQUITY_BATCH) {
    publish(REDIS_EQUITY_CHANNEL, batch.slice(offset, offset + MAX_EQUITY_BATCH))
  }
}

/**
 * Deliver a batch to whichever of its recipients are connected here.
 *
 * On a gateway most entries will not match a local socket, and that is expected:
 * the batch is broadcast to every gateway and each keeps its own. The lookup is
 * a Map hit, so the discarded majority costs almost nothing.
 */
function deliverEquityBatch(batch) {
  if (!Array.isArray(batch)) return
  for (const entry of batch) {
    if (!entry || !entry.userId) continue
    const delivered = socketRegistry.emitToUser(entry.userId, 'equity_update', entry.payload, true)
    if (delivered > 0) _stats.equitySnapshotsEmitted++
  }
}

// ─── Redis bridge ─────────────────────────────────────────────────────────────
/**
 * Publish one message for sibling instances.
 *
 * Silently does nothing when no publisher is connected — the single-instance,
 * no-Redis case, where local delivery has already covered everyone. That is why
 * every caller delivers locally first and publishes second rather than choosing
 * between them.
 */
function publish(channel, message) {
  if (!_redisPublisher) return
  _redisPublisher.publish(channel, JSON.stringify({ origin: INSTANCE_ID, message }))
    .catch((error) => {
      logger.error('[realtimeFanout] publish failed:', { channel, error: error.message })
    })
}

/** Unwrap an envelope, or null if this process published it. */
function unwrap(raw) {
  const envelope = JSON.parse(raw)
  if (envelope.origin === INSTANCE_ID) return null
  return envelope.message
}

/**
 * Wire the cross-instance bridge.
 *
 * Who does what:
 *   engine   publishes only  — its traders are on other machines
 *   gateway  consumes only   — it produces nothing
 *   all      both            — it delivers to its own sockets directly AND
 *                             publishes for siblings, because a scaled `all`
 *                             deployment used to rely on the Socket.IO Redis
 *                             adapter to carry per-user events between replicas
 *                             and no longer does
 *
 * A single instance with Redis pays one publish per flush that nobody consumes.
 * That is a few hundred bytes a second, against the per-recipient adapter
 * publishes this replaced.
 *
 * Failure is deliberately not fatal on the engine: a broker outage should
 * degrade dashboards, never stop the process that closes stop-losses.
 */
async function startRedisBridge() {
  const publishes = role.publishesRealtimeOverRedis() || role.ROLE === 'all'
  const consumes = role.ROLE === 'gateway' || role.ROLE === 'all'
  if (!publishes && !consumes) return false

  const client = getRedisClient()
  if (!client) {
    // Fatal-sounding only where it actually is: a gateway without Redis accepts
    // connections and then sends nothing, forever, with no other symptom.
    if (role.ROLE === 'all') {
      logger.warn('[realtimeFanout] No Redis — realtime events stay in this process. ' +
        'Correct on a single instance; traders on other replicas would receive nothing.')
    } else {
      logger.error(`[realtimeFanout] ROLE=${role.ROLE} needs Redis to reach traders and none is connected. ` +
        'Prices and equity will not leave this process.')
    }
    return false
  }

  try {
    if (publishes) {
      _redisPublisher = client.duplicate()
      _redisPublisher.on('error', (err) => logger.error('[realtimeFanout] publisher error:', { error: err.message }))
      await _redisPublisher.connect()
    }

    if (consumes) {
      // A client in subscriber mode cannot serve ordinary commands, so this must
      // be its own connection — the same reason attachRedisAdapter duplicates.
      _redisSubscriber = client.duplicate()
      _redisSubscriber.on('error', (err) => logger.error('[realtimeFanout] subscriber error:', { error: err.message }))
      await _redisSubscriber.connect()

      await _redisSubscriber.subscribe(REDIS_PRICE_CHANNEL, (raw) => {
        try {
          const delta = unwrap(raw)
          if (delta) deliverPriceDelta(delta)
        } catch (error) {
          logger.warn('[realtimeFanout] bad price message:', { error: error.message })
        }
      })
      await _redisSubscriber.subscribe(REDIS_EQUITY_CHANNEL, (raw) => {
        try {
          const batch = unwrap(raw)
          if (batch) deliverEquityBatch(batch)
        } catch (error) {
          logger.warn('[realtimeFanout] bad equity message:', { error: error.message })
        }
      })
    }

    logger.info('[realtimeFanout] Redis bridge started', { role: role.ROLE, publishes, consumes })
    return true
  } catch (error) {
    logger.error('[realtimeFanout] Redis bridge failed to start:', { error: error.message })
    return false
  }
}

async function stopRedisBridge() {
  const closing = []
  if (_redisSubscriber) { closing.push(_redisSubscriber.quit().catch(() => {})); _redisSubscriber = null }
  if (_redisPublisher) { closing.push(_redisPublisher.quit().catch(() => {})); _redisPublisher = null }
  if (_priceFlushTimer) { clearTimeout(_priceFlushTimer); _priceFlushTimer = null }
  await Promise.all(closing)
}

function getFanoutStats() {
  return {
    ..._stats,
    instanceId: INSTANCE_ID,
    priceBroadcastMs: PRICE_BROADCAST_MS,
    equityPushIntervalMs: EQUITY_PUSH_INTERVAL_MS,
    pendingInstruments: _pendingInstruments.size,
    pendingEquity: _pendingEquity.size,
    localUsers: socketRegistry.getUserCount(),
    localSockets: socketRegistry.getSocketCount()
  }
}

function __reset() {
  _pendingInstruments = new Set()
  _pendingEquity.clear()
  _lastEquityPushAt.clear()
  if (_priceFlushTimer) { clearTimeout(_priceFlushTimer); _priceFlushTimer = null }
  _lastPriceFlushAt = 0
  for (const key of Object.keys(_stats)) _stats[key] = 0
}

/**
 * Install a publisher double, so a test can observe what would go to Redis.
 *
 * The chunking this exists to verify has no locally observable effect — messages
 * are the same total bytes and local delivery is identical either way. The only
 * thing that changes is the size of each message leaving the process, so the
 * only way to test it is to look at the messages.
 */
async function __setPublisherForTest(client) {
  _redisPublisher = client
}

module.exports = {
  ALL_PRICES_ROOM,
  PRICE_ROOM_PREFIX,
  MAX_SUBSCRIPTIONS,
  MAX_EQUITY_BATCH,
  attach,
  queuePriceDelta,
  broadcastSnapshot,
  queueEquityUpdates,
  setSocketSubscriptions,
  deliverPriceDelta,
  deliverEquityBatch,
  flushPrices,
  startRedisBridge,
  stopRedisBridge,
  getFanoutStats,
  __reset,
  __setPublisherForTest
}
