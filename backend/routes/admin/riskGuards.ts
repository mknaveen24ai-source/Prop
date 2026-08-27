// Admin news protection, rollover guard, slippage monitor, and feed anomalies.

import type {
  AdminDriftMonitorItemDto,
  AdminFeedAnomaliesResponseDto,
  AdminFeedInstrumentHealthDto,
  AdminNewsProtectionSettingsDto,
  AdminRiskSettingSavedDto,
  AdminRolloverGuardSettingsDto,
  AdminSlippageMonitorResponseDto,
  AdminSpreadMonitorItemDto,
  LegacyErrorResponse
} from '@propfirm/contracts'
import express from 'express'
import type {
  Request as ExpressRequest,
  RequestHandler,
  Response as ExpressResponse,
  Router
} from 'express'
import type { PoolClient, QueryResultRow } from 'pg'
import { z } from 'zod'
import {
  getQuickMoveThreshold,
  getSpreadPoints,
  getWideSpreadThreshold
} from '../../constants'
import pool = require('../../db')
import '../../loadEnv'
import logger = require('../../utils/logger')
import { appendImmutableAudit } from './shared/audit'

interface MiddlewareApi {
  authenticateAdmin: RequestHandler
}

interface SchemaApi {
  getSettingsMap: (keys: string[]) => Promise<Record<string, string | null | undefined>>
  upsertSetting: (client: PoolClient, key: string, value: unknown) => Promise<unknown>
  toBool: (value: unknown, fallback?: boolean) => boolean
}

interface PriceFeedRow extends QueryResultRow {
  instrument: string
  bid: string | null
  ask: string | null
  updated_at: Date | string | null
}

interface RecentTradeRow extends QueryResultRow {
  instrument: string
  direction: string
  open_price: string | null
  close_price: string | null
  open_time: Date | string
  close_time: Date | string
}

interface RiskSettingUpdate {
  key: string
  value: unknown
}

interface RiskSettingAuditInput {
  eventType: string
  entityType: 'risk_setting'
  entityId: 'news_protection' | 'rollover_guard'
  payload: AdminNewsProtectionSettingsDto | AdminRolloverGuardSettingsDto
}

interface SaveRiskDependencies {
  upsert: (client: PoolClient, key: string, value: unknown) => Promise<unknown>
  audit: (client: PoolClient, input: RiskSettingAuditInput) => Promise<unknown>
}

interface RiskGuardsTestApi {
  buildFeedAnomalies: (
    sourceRows: PriceFeedRow[],
    staleThreshold: number,
    now: number
  ) => Omit<AdminFeedAnomaliesResponseDto, 'generated_at'>
  buildSlippageMonitor: (
    prices: PriceFeedRow[],
    recent: RecentTradeRow[]
  ) => Omit<AdminSlippageMonitorResponseDto, 'generated_at'>
  normalizeNewsProtection: (body: unknown) => AdminNewsProtectionSettingsDto
  normalizeRolloverGuard: (body: unknown) => AdminRolloverGuardSettingsDto
  persistRiskSettings: (
    client: PoolClient,
    updates: RiskSettingUpdate[],
    auditInput: RiskSettingAuditInput,
    dependencies: SaveRiskDependencies
  ) => Promise<void>
}

interface RiskGuardsRouter extends Router {
  __test__: RiskGuardsTestApi
}

type RiskGuardsResponse = AdminNewsProtectionSettingsDto
  | AdminRolloverGuardSettingsDto
  | AdminRiskSettingSavedDto
  | AdminSlippageMonitorResponseDto
  | AdminFeedAnomaliesResponseDto
  | LegacyErrorResponse
type RiskRequest = ExpressRequest<Record<string, string>, RiskGuardsResponse, unknown>
type RiskResponse = ExpressResponse<RiskGuardsResponse>

const { authenticateAdmin } = require('../middleware') as MiddlewareApi
const { getSettingsMap, upsertSetting, toBool } = require('./shared/schema') as SchemaApi
const router = express.Router() as RiskGuardsRouter
const requestBodySchema = z.record(z.string(), z.unknown())

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

function bodyRecord(value: unknown): Record<string, unknown> {
  const result = requestBodySchema.safeParse(value)
  return result.success ? result.data : {}
}

function isoOrNull(value: Date | string | null): string | null {
  if (value === null || value === '') return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function normalizeNewsProtection(bodyValue: unknown): AdminNewsProtectionSettingsDto {
  const body = bodyRecord(bodyValue)
  return {
    enabled: toBool(body.enabled, false),
    lookahead_minutes: Math.max(0, Number.parseInt(String(body.lookahead_minutes || 3), 10)),
    max_lots_multiplier: Math.max(0.05, Number.parseFloat(String(body.max_lots_multiplier || 0.6))),
    block_new_orders: toBool(body.block_new_orders, true)
  }
}

function normalizeRolloverGuard(bodyValue: unknown): AdminRolloverGuardSettingsDto {
  const body = bodyRecord(bodyValue)
  return {
    enabled: toBool(body.enabled, true),
    start_utc: String(body.start_utc || '21:55'),
    end_utc: String(body.end_utc || '22:05'),
    block_new_orders: toBool(body.block_new_orders, true)
  }
}

async function persistRiskSettings(
  client: PoolClient,
  updates: RiskSettingUpdate[],
  auditInput: RiskSettingAuditInput,
  dependencies: SaveRiskDependencies
): Promise<void> {
  try {
    await client.query('BEGIN')
    for (const update of updates) {
      await dependencies.upsert(client, update.key, update.value)
    }
    try {
      await dependencies.audit(client, auditInput)
    } catch (error: unknown) {
      logger.warn('[admin] Non-critical operation failed silently:', { error: errorMessage(error) })
    }
    await client.query('COMMIT')
  } catch (error: unknown) {
    await client.query('ROLLBACK')
    throw error
  }
}

function buildSlippageMonitor(
  prices: PriceFeedRow[],
  recent: RecentTradeRow[]
): Omit<AdminSlippageMonitorResponseDto, 'generated_at'> {
  const spreadMonitor: AdminSpreadMonitorItemDto[] = prices.map((row) => {
    const bid = Number.parseFloat(row.bid || '0')
    const ask = Number.parseFloat(row.ask || '0')
    const spreadPoints = getSpreadPoints(Math.max(0, ask - bid), row.instrument)
    const threshold = getWideSpreadThreshold(row.instrument)
    return {
      instrument: row.instrument,
      spread_points: Number.parseFloat(spreadPoints.toFixed(2)),
      threshold_points: threshold,
      is_alert: spreadPoints > threshold,
      updated_at: isoOrNull(row.updated_at)
    }
  })

  let suspicious = 0
  const byInstrument: Record<string, AdminDriftMonitorItemDto> = {}
  for (const trade of recent) {
    const openPrice = Number.parseFloat(trade.open_price || '0')
    const closePrice = Number.parseFloat(trade.close_price || '0')
    const holdSeconds = Math.max(
      0,
      (new Date(trade.close_time).getTime() - new Date(trade.open_time).getTime()) / 1000
    )
    const points = getSpreadPoints(Math.abs(closePrice - openPrice), trade.instrument)
    const threshold = getQuickMoveThreshold(trade.instrument)
    const existing = byInstrument[trade.instrument]
    const group = existing || {
      instrument: trade.instrument,
      trades: 0,
      avg_move_points: 0,
      suspicious_quick_moves: 0
    }
    byInstrument[trade.instrument] = group
    group.trades += 1
    group.avg_move_points += points
    if (holdSeconds < 60 && points > threshold) {
      suspicious += 1
      group.suspicious_quick_moves += 1
    }
  }

  const driftMonitor = Object.values(byInstrument)
    .map((row): AdminDriftMonitorItemDto => ({
      ...row,
      avg_move_points: row.trades > 0
        ? Number.parseFloat((row.avg_move_points / row.trades).toFixed(2))
        : 0
    }))
    .sort((left, right) => right.suspicious_quick_moves - left.suspicious_quick_moves)

  return {
    spread_monitor: spreadMonitor.sort(
      (left, right) => (right.is_alert ? 1 : 0) - (left.is_alert ? 1 : 0)
    ),
    drift_monitor: driftMonitor,
    suspicious_quick_moves: suspicious,
    sample_count: recent.length
  }
}

function buildFeedAnomalies(
  sourceRows: PriceFeedRow[],
  staleThreshold: number,
  now: number
): Omit<AdminFeedAnomaliesResponseDto, 'generated_at'> {
  let staleCount = 0
  let wideSpreadCount = 0
  const instruments: AdminFeedInstrumentHealthDto[] = sourceRows.map((row) => {
    const bid = Number.parseFloat(row.bid || '0')
    const ask = Number.parseFloat(row.ask || '0')
    const spreadPoints = getSpreadPoints(Math.max(0, ask - bid), row.instrument)
    const spreadThreshold = getWideSpreadThreshold(row.instrument)
    const updatedAt = isoOrNull(row.updated_at)
    const ageSeconds = updatedAt
      ? Math.max(0, Math.floor((now - new Date(updatedAt).getTime()) / 1000))
      : 999999
    const stale = ageSeconds > staleThreshold
    const wideSpread = spreadPoints > spreadThreshold
    if (stale) staleCount += 1
    if (wideSpread) wideSpreadCount += 1
    return {
      instrument: row.instrument,
      bid,
      ask,
      spread_points: Number.parseFloat(spreadPoints.toFixed(2)),
      spread_threshold: spreadThreshold,
      seconds_since_update: ageSeconds,
      stale,
      wide_spread: wideSpread
    }
  })
  const anomalies = instruments.filter((row) => row.stale || row.wide_spread)
  return {
    stale_threshold_seconds: staleThreshold,
    stale_count: staleCount,
    wide_spread_count: wideSpreadCount,
    any_anomaly: anomalies.length > 0,
    instruments,
    anomalies
  }
}

async function getNewsProtectionHandler(
  _req: RiskRequest,
  res: RiskResponse
): Promise<ExpressResponse<RiskGuardsResponse>> {
  try {
    const settings = await getSettingsMap([
      'news_protection_enabled',
      'news_protection_lookahead_minutes',
      'news_protection_max_lots_multiplier',
      'news_protection_block_new_orders'
    ])
    return res.json({
      enabled: toBool(settings.news_protection_enabled, false),
      lookahead_minutes: Number.parseInt(settings.news_protection_lookahead_minutes || '3', 10),
      max_lots_multiplier: Number.parseFloat(settings.news_protection_max_lots_multiplier || '0.6'),
      block_new_orders: toBool(settings.news_protection_block_new_orders, true)
    })
  } catch (_error: unknown) {
    return res.status(500).json({ error: 'Failed to load news protection settings' })
  }
}

async function saveNewsProtectionHandler(
  req: RiskRequest,
  res: RiskResponse
): Promise<ExpressResponse<RiskGuardsResponse>> {
  const client = await pool.connect()
  try {
    const settings = normalizeNewsProtection(req.body)
    await persistRiskSettings(
      client,
      [
        { key: 'news_protection_enabled', value: settings.enabled },
        { key: 'news_protection_lookahead_minutes', value: settings.lookahead_minutes },
        { key: 'news_protection_max_lots_multiplier', value: settings.max_lots_multiplier },
        { key: 'news_protection_block_new_orders', value: settings.block_new_orders }
      ],
      {
        eventType: 'news_protection_updated',
        entityType: 'risk_setting',
        entityId: 'news_protection',
        payload: settings
      },
      { upsert: upsertSetting, audit: appendImmutableAudit }
    )
    return res.json({ message: 'News protection settings saved' })
  } catch (_error: unknown) {
    return res.status(500).json({ error: 'Failed to save news protection settings' })
  } finally {
    client.release()
  }
}

async function getRolloverGuardHandler(
  _req: RiskRequest,
  res: RiskResponse
): Promise<ExpressResponse<RiskGuardsResponse>> {
  try {
    const settings = await getSettingsMap([
      'rollover_guard_enabled',
      'rollover_guard_start_utc',
      'rollover_guard_end_utc',
      'rollover_guard_block_new_orders'
    ])
    return res.json({
      enabled: toBool(settings.rollover_guard_enabled, true),
      start_utc: settings.rollover_guard_start_utc || '21:55',
      end_utc: settings.rollover_guard_end_utc || '22:05',
      block_new_orders: toBool(settings.rollover_guard_block_new_orders, true)
    })
  } catch (_error: unknown) {
    return res.status(500).json({ error: 'Failed to load rollover guard settings' })
  }
}

async function saveRolloverGuardHandler(
  req: RiskRequest,
  res: RiskResponse
): Promise<ExpressResponse<RiskGuardsResponse>> {
  const client = await pool.connect()
  try {
    const settings = normalizeRolloverGuard(req.body)
    await persistRiskSettings(
      client,
      [
        { key: 'rollover_guard_enabled', value: settings.enabled },
        { key: 'rollover_guard_start_utc', value: settings.start_utc },
        { key: 'rollover_guard_end_utc', value: settings.end_utc },
        { key: 'rollover_guard_block_new_orders', value: settings.block_new_orders }
      ],
      {
        eventType: 'rollover_guard_updated',
        entityType: 'risk_setting',
        entityId: 'rollover_guard',
        payload: settings
      },
      { upsert: upsertSetting, audit: appendImmutableAudit }
    )
    return res.json({ message: 'Rollover guard settings saved' })
  } catch (_error: unknown) {
    return res.status(500).json({ error: 'Failed to save rollover guard settings' })
  } finally {
    client.release()
  }
}

async function getSlippageMonitorHandler(
  _req: RiskRequest,
  res: RiskResponse
): Promise<ExpressResponse<RiskGuardsResponse>> {
  try {
    const [prices, recent] = await Promise.all([
      pool.query<PriceFeedRow>('SELECT instrument, bid, ask, updated_at FROM price_feed'),
      pool.query<RecentTradeRow>(
        `SELECT instrument, direction, open_price, close_price, open_time, close_time
           FROM trades
          WHERE status = 'closed'
            AND close_time >= NOW() - INTERVAL '24 hours'
            AND open_price IS NOT NULL
            AND close_price IS NOT NULL
          ORDER BY close_time DESC
          LIMIT 3000`
      )
    ])
    return res.json({ generated_at: new Date().toISOString(), ...buildSlippageMonitor(prices.rows, recent.rows) })
  } catch (_error: unknown) {
    return res.status(500).json({ error: 'Failed to load slippage monitor' })
  }
}

async function getFeedAnomaliesHandler(
  _req: RiskRequest,
  res: RiskResponse
): Promise<ExpressResponse<RiskGuardsResponse>> {
  try {
    const settings = await getSettingsMap(['feed_stale_threshold_seconds'])
    const staleThreshold = Math.max(
      5,
      Number.parseInt(settings.feed_stale_threshold_seconds || '30', 10)
    )
    const result = await pool.query<PriceFeedRow>(
      'SELECT instrument, bid, ask, updated_at FROM price_feed'
    )
    const generatedAt = new Date()
    return res.json({
      generated_at: generatedAt.toISOString(),
      ...buildFeedAnomalies(result.rows, staleThreshold, generatedAt.getTime())
    })
  } catch (_error: unknown) {
    return res.status(500).json({ error: 'Failed to load feed anomalies' })
  }
}

router.get('/news-protection', authenticateAdmin, getNewsProtectionHandler)
router.post('/news-protection', authenticateAdmin, saveNewsProtectionHandler)
router.get('/rollover-guard', authenticateAdmin, getRolloverGuardHandler)
router.post('/rollover-guard', authenticateAdmin, saveRolloverGuardHandler)
router.get('/slippage-monitor', authenticateAdmin, getSlippageMonitorHandler)
router.get('/feed-anomalies', authenticateAdmin, getFeedAnomaliesHandler)

router.__test__ = {
  buildFeedAnomalies,
  buildSlippageMonitor,
  normalizeNewsProtection,
  normalizeRolloverGuard,
  persistRiskSettings
}

export = router
