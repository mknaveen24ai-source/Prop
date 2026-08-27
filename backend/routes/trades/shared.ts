// Helpers shared by more than one trades sub-module.
//
// Single-consumer helpers stay with their route: normalizePositiveNumber lives
// in open.js, mapTradeRow in history.js.

import fs from 'node:fs'
import path from 'node:path'
import type tradeEngineModule = require('../../services/tradeEngine')
import tradeShared = require('../../services/tradeShared')

type TradeEngineApi = typeof tradeEngineModule

interface ValidationApi {
  sanitizeString: (value: string, maxLength?: number) => string
}

interface PersistTradeScreenshotInput {
  tradeId: unknown
  userId: unknown
  kind: unknown
  dataUrl: unknown
}

const { sanitizeString } = require('../../utils/validation') as ValidationApi
const { TRADE_JOURNAL_UPLOAD_ROOT } = tradeShared

// Resolved lazily so this file and services/tradeEngine.js can require each
// other's exports without depending on which one Node loads first.
let cachedTradeEngine: TradeEngineApi | null = null
function engine(): TradeEngineApi {
  if (!cachedTradeEngine) {
    cachedTradeEngine = require('../../services/tradeEngine') as TradeEngineApi
  }
  return cachedTradeEngine
}

function isValidImageDataUrl(dataUrl: unknown): dataUrl is string {
  return typeof dataUrl === 'string'
    && /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl.trim())
}

async function persistTradeScreenshot({
  tradeId,
  userId,
  kind,
  dataUrl
}: PersistTradeScreenshotInput): Promise<string | null> {
  if (!isValidImageDataUrl(dataUrl)) {
    return null
  }

  const normalizedKind = kind === 'close' ? 'close' : 'open'
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i)
  if (!match) return null

  const matchedFormat = match[1]
  const matchedPayload = match[2]
  if (!matchedFormat || !matchedPayload) return null
  const format = matchedFormat.toLowerCase() === 'jpeg' ? 'jpg' : matchedFormat.toLowerCase()
  const buffer = Buffer.from(matchedPayload, 'base64')
  if (!buffer.length || buffer.length > 1_500_000) {
    return null
  }

  const userPart = sanitizeString(String(userId || 'user'), 64) || 'user'
  const tradePart = sanitizeString(String(tradeId || 'trade'), 64) || 'trade'
  const relativeDir = path.join(userPart)
  const absoluteDir = path.join(TRADE_JOURNAL_UPLOAD_ROOT, relativeDir)
  await fs.promises.mkdir(absoluteDir, { recursive: true })

  const filename = `${tradePart}-${normalizedKind}-${Date.now()}.${format}`
  const absolutePath = path.join(absoluteDir, filename)
  await fs.promises.writeFile(absolutePath, buffer)

  return path.join(relativeDir, filename).replace(/\\/g, '/')
}

function buildTradeScreenshotAbsolutePath(relativePath: unknown): string | null {
  if (!relativePath || typeof relativePath !== 'string') return null
  const resolved = path.resolve(TRADE_JOURNAL_UPLOAD_ROOT, relativePath)
  return resolved.startsWith(TRADE_JOURNAL_UPLOAD_ROOT) ? resolved : null
}

const tradeRouteShared = {
  engine,
  isValidImageDataUrl,
  persistTradeScreenshot,
  buildTradeScreenshotAbsolutePath
}

export = tradeRouteShared
