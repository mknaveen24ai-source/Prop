import assert from 'node:assert/strict'
import test from 'node:test'
import type { PoolClient } from 'pg'
import router = require('../routes/admin/riskGuards')

type Persist = typeof router.__test__.persistRiskSettings
type Updates = Parameters<Persist>[1]
type AuditInput = Parameters<Persist>[2]
type Dependencies = Parameters<Persist>[3]
type PriceRows = Parameters<typeof router.__test__.buildFeedAnomalies>[0]
type RecentRows = Parameters<typeof router.__test__.buildSlippageMonitor>[1]

interface ClientState {
  client: PoolClient
  events: string[]
}

function makeClient(): ClientState {
  const events: string[] = []
  const client = {
    async query(sqlInput: unknown) {
      events.push(String(sqlInput))
      return { rows: [], rowCount: 1 }
    },
    release() {}
  } as unknown as PoolClient
  return { client, events }
}

function inputs(): { updates: Updates; auditInput: AuditInput } {
  return {
    updates: [
      { key: 'news_protection_enabled', value: true },
      { key: 'news_protection_lookahead_minutes', value: 7 }
    ],
    auditInput: {
      eventType: 'news_protection_updated',
      entityType: 'risk_setting',
      entityId: 'news_protection',
      payload: {
        enabled: true,
        lookahead_minutes: 7,
        max_lots_multiplier: 0.6,
        block_new_orders: true
      }
    }
  }
}

void test('risk-setting bodies start unknown and retain the existing coercion defaults', () => {
  assert.deepEqual(router.__test__.normalizeNewsProtection({
    enabled: 'yes',
    lookahead_minutes: '-5',
    max_lots_multiplier: '0.01',
    block_new_orders: 'false'
  }), {
    enabled: true,
    lookahead_minutes: 0,
    max_lots_multiplier: 0.05,
    block_new_orders: false
  })
  assert.deepEqual(router.__test__.normalizeRolloverGuard('not-an-object'), {
    enabled: true,
    start_utc: '21:55',
    end_utc: '22:05',
    block_new_orders: true
  })
})

void test('risk-setting persistence keeps updates and audit inside one transaction', async () => {
  const state = makeClient()
  const { updates, auditInput } = inputs()
  const dependencies: Dependencies = {
    upsert: async (_client, key, value) => { state.events.push(`upsert:${key}:${String(value)}`) },
    audit: async (_client, input) => { state.events.push(`audit:${input.entityId}`) }
  }
  await router.__test__.persistRiskSettings(state.client, updates, auditInput, dependencies)

  assert.deepEqual(state.events, [
    'BEGIN',
    'upsert:news_protection_enabled:true',
    'upsert:news_protection_lookahead_minutes:7',
    'audit:news_protection',
    'COMMIT'
  ])
})

void test('an audit failure stays best-effort and the risk settings still commit', async () => {
  const state = makeClient()
  const { updates, auditInput } = inputs()
  await router.__test__.persistRiskSettings(state.client, updates, auditInput, {
    upsert: async () => undefined,
    audit: async () => { throw new Error('forced audit failure') }
  })
  assert.deepEqual(state.events, ['BEGIN', 'COMMIT'])
})

void test('an update failure rolls the entire risk-settings transaction back', async () => {
  const state = makeClient()
  const { updates, auditInput } = inputs()
  await assert.rejects(
    router.__test__.persistRiskSettings(state.client, updates, auditInput, {
      upsert: async () => { throw new Error('forced update failure') },
      audit: async () => undefined
    }),
    /forced update failure/u
  )
  assert.deepEqual(state.events, ['BEGIN', 'ROLLBACK'])
})

void test('feed anomalies classify stale and wide-spread synthetic quotes deterministically', () => {
  const now = Date.parse('2026-08-27T12:00:00.000Z')
  const rows: PriceRows = [
    {
      instrument: 'EURUSD',
      bid: '1.10000',
      ask: '1.10010',
      updated_at: '2026-08-27T11:59:00.000Z'
    },
    {
      instrument: 'EURUSD',
      bid: '1.10000',
      ask: '1.10001',
      updated_at: '2026-08-27T11:59:55.000Z'
    }
  ]
  const result = router.__test__.buildFeedAnomalies(rows, 30, now)
  assert.equal(result.stale_count, 1)
  assert.equal(result.wide_spread_count, 1)
  assert.equal(result.any_anomaly, true)
  assert.equal(result.anomalies.length, 1)
  assert.deepEqual(result.instruments.map((row) => row.seconds_since_update), [60, 5])
})

void test('slippage monitor detects a quick synthetic move without any MT5 dependency', () => {
  const prices: PriceRows = [{
    instrument: 'EURUSD',
    bid: '1.10000',
    ask: '1.10010',
    updated_at: '2026-08-27T12:00:00.000Z'
  }]
  const recent: RecentRows = [
    {
      instrument: 'EURUSD',
      direction: 'buy',
      open_price: '1.10000',
      close_price: '1.10030',
      open_time: '2026-08-27T11:59:30.000Z',
      close_time: '2026-08-27T12:00:00.000Z'
    },
    {
      instrument: 'EURUSD',
      direction: 'sell',
      open_price: '1.10000',
      close_price: '1.10010',
      open_time: '2026-08-27T11:55:00.000Z',
      close_time: '2026-08-27T12:00:00.000Z'
    }
  ]
  const result = router.__test__.buildSlippageMonitor(prices, recent)
  assert.equal(result.sample_count, 2)
  assert.equal(result.suspicious_quick_moves, 1)
  assert.equal(result.spread_monitor[0]?.is_alert, true)
  assert.equal(result.drift_monitor[0]?.trades, 2)
  assert.equal(result.drift_monitor[0]?.suspicious_quick_moves, 1)
})
