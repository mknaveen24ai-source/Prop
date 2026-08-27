// Propagate HTTP-originated trade mutations to the single engine process.
// The index deliberately remains local and synchronous; Redis is only the
// low-latency invalidation/mutation bus between stateless API nodes and engine.
import { randomUUID } from 'node:crypto'
import type { createClient } from 'redis'
import { z } from 'zod'
import { ROLE } from '../config/role'
import logger = require('../utils/logger')
import { parseExternal, parseUnknownJson } from '../validation/unknown'

type RedisClient = ReturnType<typeof createClient>
type NumericValue = string | number

interface TradeReference extends Record<string, unknown> {
  account_id: string
}

interface TradeEngineApi {
  syncOpenedTrade: (trade: TradeReference) => Promise<void>
  syncPendingOrder: (trade: TradeReference) => Promise<void>
  syncClosedTrade: (tradeId: string, accountId: string, realizedPnl: NumericValue) => void
}

interface AccountEntry {
  id?: string
}

interface TradeIndexApi {
  applyRealizedPnl: (accountId: string, realizedPnl: NumericValue) => void
  updateAccountBalance: (accountId: string, currentBalance: NumericValue) => void
  getAccountEntry: (accountId: string) => AccountEntry | null | undefined
}

const numericValueSchema = z.union([z.string().min(1), z.number().finite()])
const tradeReferenceSchema = z.object({ account_id: z.string().min(1) }).passthrough()
const openMutationSchema = z.object({
  type: z.literal('open'),
  payload: z.object({
    trade: tradeReferenceSchema,
    realizedPnl: numericValueSchema.nullable().optional(),
    currentBalance: numericValueSchema.nullable().optional()
  })
})
const pendingMutationSchema = z.object({
  type: z.literal('pending'),
  payload: z.object({ trade: tradeReferenceSchema })
})
const closedMutationSchema = z.object({
  type: z.literal('closed'),
  payload: z.object({
    tradeId: z.string().min(1),
    accountId: z.string().min(1),
    realizedPnl: numericValueSchema,
    currentBalance: numericValueSchema.nullable().optional()
  })
})
const mutationSchema = z.discriminatedUnion('type', [
  openMutationSchema,
  pendingMutationSchema,
  closedMutationSchema
])
const syncEnvelopeSchema = z.discriminatedUnion('type', [
  openMutationSchema.extend({ origin: z.string().min(1) }),
  pendingMutationSchema.extend({ origin: z.string().min(1) }),
  closedMutationSchema.extend({ origin: z.string().min(1) })
])

type TradeIndexMutation = z.infer<typeof mutationSchema>

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function loadTradeEngine(): TradeEngineApi {
  return require('./tradeEngine') as TradeEngineApi
}

function loadTradeIndex(): TradeIndexApi {
  return require('../utils/tradeIndex') as TradeIndexApi
}

const CHANNEL = 'propfirm:trade-index:v1'
const INSTANCE_ID = process.env.INSTANCE_ID || randomUUID()
let publisher: RedisClient | null = null
let subscriber: RedisClient | null = null

function envelope(mutation: TradeIndexMutation): string {
  return JSON.stringify({ origin: INSTANCE_ID, ...mutation })
}

async function publish(type: unknown, payload: unknown): Promise<boolean> {
  // Monoliths update their local index directly. Publishing there would only
  // add a network hop and make the same process consume its own mutation.
  if (ROLE !== 'api' || !publisher) return false
  const parsed = mutationSchema.safeParse({ type, payload })
  if (!parsed.success) {
    logger.error('[tradeIndexSync] refused invalid mutation', { type, issues: parsed.error.issues })
    return false
  }
  try {
    await publisher.publish(CHANNEL, envelope(parsed.data))
    return true
  } catch (error: unknown) {
    // The database transaction already committed. Never turn a successful
    // order into a misleading HTTP 500 merely because the low-latency hint was
    // unavailable; the engine's bounded reconcile is the recovery mechanism.
    logger.error('[tradeIndexSync] publish failed; reconcile will recover', { error: errorMessage(error), type })
    return false
  }
}

async function applyMutation(input: unknown): Promise<null | void> {
  const message = parseExternal(mutationSchema, input, 'trade-index mutation')
  const engine = loadTradeEngine()
  const tradeIndex = loadTradeIndex()
  const { type, payload } = message

  if (type === 'open') {
    await engine.syncOpenedTrade(payload.trade)
    if (payload.realizedPnl != null) tradeIndex.applyRealizedPnl(payload.trade.account_id, payload.realizedPnl)
    if (payload.currentBalance != null) tradeIndex.updateAccountBalance(payload.trade.account_id, payload.currentBalance)
    return null
  }
  if (type === 'pending') return engine.syncPendingOrder(payload.trade)
  if (type === 'closed') {
    engine.syncClosedTrade(payload.tradeId, payload.accountId, payload.realizedPnl)
    const account = tradeIndex.getAccountEntry(payload.accountId)
    if (account && payload.currentBalance != null) {
      tradeIndex.updateAccountBalance(payload.accountId, payload.currentBalance)
    }
    return null
  }
  return null
}

async function start(client: RedisClient | null | undefined): Promise<boolean> {
  if (!client || (ROLE !== 'api' && ROLE !== 'engine')) return false
  if (ROLE === 'api' && !publisher) {
    publisher = client.duplicate()
    publisher.on('error', (error: Error) => logger.error('[tradeIndexSync] publisher error', { error: error.message }))
    await publisher.connect()
  }
  if (ROLE === 'engine' && !subscriber) {
    subscriber = client.duplicate()
    subscriber.on('error', (error: Error) => logger.error('[tradeIndexSync] subscriber error', { error: error.message }))
    await subscriber.connect()
    await subscriber.subscribe(CHANNEL, (raw: string) => {
      try {
        const parsedJson = parseUnknownJson(raw)
        const message = parseExternal(syncEnvelopeSchema, parsedJson, 'Redis trade-index envelope')
        if (message.origin === INSTANCE_ID) return
        void applyMutation(message).catch((error: unknown) => {
          logger.error('[tradeIndexSync] apply failed', {
            error: errorMessage(error),
            type: message.type
          })
        })
      } catch (error: unknown) {
        logger.warn('[tradeIndexSync] ignored malformed mutation', { error: errorMessage(error) })
      }
    })
  }
  return true
}

async function stop(): Promise<void> {
  await Promise.all([publisher?.quit().catch(() => {}), subscriber?.quit().catch(() => {})])
  publisher = null
  subscriber = null
}

export { start, stop, publish, applyMutation, CHANNEL }
