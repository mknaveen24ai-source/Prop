// Helpers shared by more than one trades sub-module.
//
// Single-consumer helpers stay with their route: normalizePositiveNumber lives
// in open.js, mapTradeRow in history.js.

const fs = require('fs')
const path = require('path')
const { sanitizeString } = require('../../utils/validation')
const { TRADE_JOURNAL_UPLOAD_ROOT } = require('../../services/tradeShared')

// Resolved lazily so this file and services/tradeEngine.js can require each
// other's exports without depending on which one Node loads first.
let _tradeEngine = null
function engine() {
  if (!_tradeEngine) _tradeEngine = require('../../services/tradeEngine')
  return _tradeEngine
}

function isValidImageDataUrl(dataUrl) {
  return typeof dataUrl === 'string'
    && /^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/i.test(dataUrl.trim())
}

async function persistTradeScreenshot({ tradeId, userId, kind, dataUrl }) {
  if (!isValidImageDataUrl(dataUrl)) {
    return null
  }

  const normalizedKind = kind === 'close' ? 'close' : 'open'
  const match = dataUrl.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/i)
  if (!match) return null

  const format = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase()
  const buffer = Buffer.from(match[2], 'base64')
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

function buildTradeScreenshotAbsolutePath(relativePath) {
  if (!relativePath || typeof relativePath !== 'string') return null
  const resolved = path.resolve(TRADE_JOURNAL_UPLOAD_ROOT, relativePath)
  return resolved.startsWith(TRADE_JOURNAL_UPLOAD_ROOT) ? resolved : null
}

module.exports = {
  engine,
  isValidImageDataUrl,
  persistTradeScreenshot,
  buildTradeScreenshotAbsolutePath
}
