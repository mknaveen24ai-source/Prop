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

import type {
  ClientToServerEvents,
  EquityUpdateDto,
  InterServerEvents,
  PriceMapDto,
  PriceUpdateDto,
  ServerToClientEvents,
  SocketData
} from '@propfirm/contracts'
import type { createClient } from 'redis'
import type { Server, Socket } from 'socket.io'
import { z } from 'zod'
import * as role from '../config/role'
import * as priceCache from '../utils/priceCache'
import { getRedisClient } from '../utils/tokenCache'
import { parseExternal, parseUnknownJson } from '../validation/unknown'
import logger = require('../utils/logger')
import * as socketRegistry from './socketRegistry'

type TypedServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>
type TypedSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>
type RedisClient = ReturnType<typeof createClient>

interface SubscriptionSocket extends Pick<TypedSocket, 'join' | 'leave'> {
  data: SocketData & { _priceRooms?: Set<string> }
}

interface EquitySnapshot {
  accountId: string
  userId: string | number
  equity: number
  floatingPnl: number
  currentBalance: number
  floor: number
  startingBalance: number
  profitTarget: number
  accountType: string
  dailyLossPct: number
  dailyDrawdownPct: number | null
}

interface EquityBatchEntry {
  userId: string
  payload: EquityUpdateDto
}

interface Publisher {
  publish: (channel: string, message: string) => Promise<unknown>
  quit?: () => Promise<unknown>
}

interface FanoutStats {
  priceFlushes: number
  priceFramesEmitted: number
  priceInstrumentsEmitted: number
  equityBatches: number
  equitySnapshotsEmitted: number
  equitySnapshotsThrottled: number
}

const priceQuoteSchema = z.object({
  bid: z.number().finite(),
  ask: z.number().finite()
}).passthrough()
const priceDeltaSchema = z.object({
  t: z.number().finite(),
  p: z.record(z.string(), priceQuoteSchema)
})
const equityPayloadSchema = z.object({
  account_id: z.string().min(1),
  equity: z.number().finite().optional(),
  floating_pnl: z.number().finite().optional(),
  current_balance: z.number().finite().optional(),
  drawdown_floor: z.number().finite().optional(),
  drawdown_used_pct: z.number().finite().optional(),
  daily_drawdown_used_pct: z.number().finite().optional(),
  daily_drawdown_limit_pct: z.number().finite().nullable().optional(),
  profit_remaining: z.number().finite().optional()
}).passthrough()
const equityBatchEntrySchema = z.object({
  userId: z.string().min(1),
  payload: equityPayloadSchema
})
const priceEnvelopeSchema = z.object({
  origin: z.string().min(1),
  message: priceDeltaSchema
})
const equityEnvelopeSchema = z.object({
  origin: z.string().min(1),
  message: z.array(equityBatchEntrySchema)
})

type ParsedEquityPayload = z.infer<typeof equityPayloadSchema>

function normalizeEquityPayload(payload: ParsedEquityPayload): EquityUpdateDto {
  const normalized: EquityUpdateDto = { account_id: payload.account_id }
  if (payload.equity !== undefined) normalized.equity = payload.equity
  if (payload.floating_pnl !== undefined) normalized.floating_pnl = payload.floating_pnl
  if (payload.current_balance !== undefined) normalized.current_balance = payload.current_balance
  if (payload.drawdown_floor !== undefined) normalized.drawdown_floor = payload.drawdown_floor
  if (payload.drawdown_used_pct !== undefined) normalized.drawdown_used_pct = payload.drawdown_used_pct
  if (payload.daily_drawdown_used_pct !== undefined) {
    normalized.daily_drawdown_used_pct = payload.daily_drawdown_used_pct
  }
  if (payload.daily_drawdown_limit_pct !== undefined) {
    normalized.daily_drawdown_limit_pct = payload.daily_drawdown_limit_pct
  }
  if (payload.profit_remaining !== undefined) normalized.profit_remaining = payload.profit_remaining
  return normalized
}

function normalizeEquityBatch(input: unknown): EquityBatchEntry[] | null {
  const parsed = z.array(equityBatchEntrySchema).safeParse(input)
  if (!parsed.success) return null
  return parsed.data.map((entry) => ({
    userId: entry.userId,
    payload: normalizeEquityPayload(entry.payload)
  }))
}

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
let _io: TypedServer | null = null
let _pendingInstruments = new Set<string>()
let _priceFlushTimer: NodeJS.Timeout | null = null
let _lastPriceFlushAt = 0

const _pendingEquity = new Map<string, EquitySnapshot>()
const _lastEquityPushAt = new Map<string, number>()

let _redisPublisher: Publisher | null = null
let _redisSubscriber: RedisClient | null = null

// Counters, surfaced through getFanoutStats() so the effect of all of this is
// observable rather than asserted.
const _stats: FanoutStats = {
  priceFlushes: 0,
  priceFramesEmitted: 0,
  priceInstrumentsEmitted: 0,
  equityBatches: 0,
  equitySnapshotsEmitted: 0,
  equitySnapshotsThrottled: 0
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function attach(io: TypedServer): void {
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
function queuePriceDelta(instruments: readonly string[] | null | undefined): void {
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

function buildPriceDelta(instruments: readonly string[]): { t: number; p: PriceMapDto } {
  const p: PriceMapDto = {}
  for (const instrument of instruments) {
    const price = priceCache.getPrice(instrument)
    if (price) p[instrument] = price
  }
  return { t: Date.now(), p }
}

function flushPrices(): void {
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
function deliverPriceDelta(delta: { t: number; p: PriceMapDto }): void {
  if (!_io) return
  const instruments = Object.keys(delta.p)

  _io.local.to(ALL_PRICES_ROOM).volatile.emit('price_update', delta)
  _stats.priceFramesEmitted++
  _stats.priceInstrumentsEmitted += instruments.length

  for (const instrument of instruments) {
    const price = delta.p[instrument]
    if (!price) continue
    _io.local.to(PRICE_ROOM_PREFIX + instrument).volatile.emit('price_update', {
      t: delta.t,
      p: { [instrument]: price }
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
function broadcastSnapshot(priceMap: unknown): void {
  const parsed = z.record(z.string(), priceQuoteSchema).safeParse(priceMap)
  if (!parsed.success) return
  const delta = { t: Date.now(), p: parsed.data }
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
function setSocketSubscriptions(
  socket: SubscriptionSocket | null | undefined,
  instruments: unknown
): { subscribed: number } {
  if (!socket) return { subscribed: 0 }

  const requested = Array.isArray(instruments) ? instruments : []
  const next = new Set<string>()
  for (const raw of requested) {
    const instrument = String(raw || '').trim().toUpperCase()
    if (!instrument) continue
    next.add(instrument)
    if (next.size >= MAX_SUBSCRIPTIONS) break
  }

  const previous = socket.data._priceRooms || new Set()
  for (const instrument of previous) {
    if (!next.has(instrument)) void socket.leave(PRICE_ROOM_PREFIX + instrument)
  }
  for (const instrument of next) {
    if (!previous.has(instrument)) void socket.join(PRICE_ROOM_PREFIX + instrument)
  }
  socket.data._priceRooms = next

  // An empty subscription means "go back to everything" rather than "silence" —
  // a client clearing its watchlist should not lose its price feed.
  if (next.size === 0) void socket.join(ALL_PRICES_ROOM)
  else void socket.leave(ALL_PRICES_ROOM)

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
function queueEquityUpdates(snapshots: readonly EquitySnapshot[] | null | undefined): void {
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

function toEquityPayload(snapshot: EquitySnapshot): EquityUpdateDto {
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

function flushEquity(): void {
  if (_pendingEquity.size === 0) return

  const batch: EquityBatchEntry[] = []
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
function deliverEquityBatch(input: unknown): void {
  const batch = normalizeEquityBatch(input)
  if (!batch) return
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
function publish(channel: string, message: PriceUpdateDto | EquityBatchEntry[]): void {
  if (!_redisPublisher) return
  _redisPublisher.publish(channel, JSON.stringify({ origin: INSTANCE_ID, message }))
    .catch((error: unknown) => {
      logger.error('[realtimeFanout] publish failed:', { channel, error: errorMessage(error) })
    })
}

/** Parse and unwrap an envelope, or null if this process published it. */
function unwrapPrice(raw: string): { t: number; p: PriceMapDto } | null {
  const envelope = parseExternal(
    priceEnvelopeSchema,
    parseUnknownJson(raw),
    'Redis realtime price envelope'
  )
  if (envelope.origin === INSTANCE_ID) return null
  return envelope.message
}

function unwrapEquity(raw: string): EquityBatchEntry[] | null {
  const envelope = parseExternal(
    equityEnvelopeSchema,
    parseUnknownJson(raw),
    'Redis realtime equity envelope'
  )
  if (envelope.origin === INSTANCE_ID) return null
  return normalizeEquityBatch(envelope.message)
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
async function startRedisBridge(): Promise<boolean> {
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
      const publisher = client.duplicate()
      publisher.on('error', (err: Error) => {
        logger.error('[realtimeFanout] publisher error:', { error: err.message })
      })
      await publisher.connect()
      _redisPublisher = publisher
    }

    if (consumes) {
      // A client in subscriber mode cannot serve ordinary commands, so this must
      // be its own connection — the same reason attachRedisAdapter duplicates.
      _redisSubscriber = client.duplicate()
      _redisSubscriber.on('error', (err: Error) => {
        logger.error('[realtimeFanout] subscriber error:', { error: err.message })
      })
      await _redisSubscriber.connect()

      await _redisSubscriber.subscribe(REDIS_PRICE_CHANNEL, (raw: string) => {
        try {
          const delta = unwrapPrice(raw)
          if (delta) deliverPriceDelta(delta)
        } catch (error: unknown) {
          logger.warn('[realtimeFanout] bad price message:', { error: errorMessage(error) })
        }
      })
      await _redisSubscriber.subscribe(REDIS_EQUITY_CHANNEL, (raw: string) => {
        try {
          const batch = unwrapEquity(raw)
          if (batch) deliverEquityBatch(batch)
        } catch (error: unknown) {
          logger.warn('[realtimeFanout] bad equity message:', { error: errorMessage(error) })
        }
      })
    }

    logger.info('[realtimeFanout] Redis bridge started', { role: role.ROLE, publishes, consumes })
    return true
  } catch (error: unknown) {
    logger.error('[realtimeFanout] Redis bridge failed to start:', { error: errorMessage(error) })
    return false
  }
}

async function stopRedisBridge(): Promise<void> {
  const closing: Promise<unknown>[] = []
  if (_redisSubscriber) { closing.push(_redisSubscriber.quit().catch(() => {})); _redisSubscriber = null }
  if (_redisPublisher?.quit) {
    closing.push(_redisPublisher.quit().catch(() => {}))
  }
  _redisPublisher = null
  if (_priceFlushTimer) { clearTimeout(_priceFlushTimer); _priceFlushTimer = null }
  await Promise.all(closing)
}

function getFanoutStats(): FanoutStats & {
  instanceId: string
  priceBroadcastMs: number
  equityPushIntervalMs: number
  pendingInstruments: number
  pendingEquity: number
  localUsers: number
  localSockets: number
} {
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

function __reset(): void {
  _pendingInstruments = new Set<string>()
  _pendingEquity.clear()
  _lastEquityPushAt.clear()
  if (_priceFlushTimer) { clearTimeout(_priceFlushTimer); _priceFlushTimer = null }
  _lastPriceFlushAt = 0
  for (const key of Object.keys(_stats) as Array<keyof FanoutStats>) _stats[key] = 0
}

/**
 * Install a publisher double, so a test can observe what would go to Redis.
 *
 * The chunking this exists to verify has no locally observable effect — messages
 * are the same total bytes and local delivery is identical either way. The only
 * thing that changes is the size of each message leaving the process, so the
 * only way to test it is to look at the messages.
 */
async function __setPublisherForTest(client: Publisher | null): Promise<void> {
  _redisPublisher = client
}

export {
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

export type { EquitySnapshot }
