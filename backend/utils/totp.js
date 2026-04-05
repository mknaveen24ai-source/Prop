/**
 * totp.js — Shared TOTP utilities
 *
 * Responsibilities:
 *  - AES-256-CBC encrypt / decrypt TOTP secrets at rest
 *  - speakeasy TOTP generation & verification (±1 step window)
 *  - Backup code generation (8 plain codes + bcrypt hashes)
 *  - Per-IP TOTP attempt tracking (in-memory, 5 failures → 15 min lock)
 */

const crypto    = require('crypto')
const speakeasy = require('speakeasy')
const bcrypt    = require('bcryptjs')

// ─── Encryption ──────────────────────────────────────────────────────────────
const ALGO     = 'aes-256-cbc'
const KEY_HEX  = process.env.TOTP_ENCRYPTION_KEY || ''
const IV_BYTES = 16

function getKey() {
  if (!KEY_HEX || KEY_HEX.length < 64) {
    throw new Error('TOTP_ENCRYPTION_KEY must be a 64-char hex string (32 bytes) in .env')
  }
  return Buffer.from(KEY_HEX, 'hex')
}

/**
 * Encrypts a plain TOTP secret → "iv_hex:ciphertext_hex"
 */
function encryptSecret(plain) {
  const key = getKey()
  const iv  = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const enc  = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${enc.toString('hex')}`
}

/**
 * Decrypts "iv_hex:ciphertext_hex" → plain TOTP secret
 */
function decryptSecret(stored) {
  const key    = getKey()
  const [ivHex, ctHex] = String(stored || '').split(':')
  if (!ivHex || !ctHex) throw new Error('Invalid encrypted secret format')
  const iv      = Buffer.from(ivHex, 'hex')
  const ct      = Buffer.from(ctHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGO, key, iv)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}

// ─── TOTP helpers ─────────────────────────────────────────────────────────────
const PLATFORM_NAME = process.env.PLATFORM_NAME || 'PropFirm'

/**
 * Generate a new TOTP secret + otpauth URL
 */
function generateSecret(label) {
  const secret = speakeasy.generateSecret({
    name:   `${PLATFORM_NAME}:${label}`,
    issuer: PLATFORM_NAME,
    length: 20,
  })
  return {
    base32:     secret.base32,
    otpauthUrl: secret.otpauth_url,
  }
}

/**
 * Verify a 6-digit TOTP token against a plain base32 secret.
 * Allows ±1 window (30 s each side) for clock drift.
 */
function verifyToken(plainSecret, token) {
  return speakeasy.totp.verify({
    secret:   plainSecret,
    encoding: 'base32',
    token:    String(token || ''),
    window:   1,
  })
}

// ─── Backup codes ─────────────────────────────────────────────────────────────
const BACKUP_COUNT      = 8
const BACKUP_BCRYPT_ROUNDS = 10

/**
 * Generate 8 random backup codes ({ plain: string[] , hashes: string[] })
 */
async function generateBackupCodes() {
  const plain   = []
  const hashes  = []
  for (let i = 0; i < BACKUP_COUNT; i++) {
    const code = crypto.randomBytes(5).toString('hex').toUpperCase() // "A1B2C3D4E5" — 10 chars
    plain.push(code)
    hashes.push(await bcrypt.hash(code, BACKUP_BCRYPT_ROUNDS))
  }
  return { plain, hashes }
}

/**
 * Find and consume a backup code.
 * Returns the matching code object or null.
 * backupCodes — parsed JSON array from DB: [{ hash, used }]
 */
async function consumeBackupCode(userInput, backupCodes) {
  const normalized = String(userInput || '').toUpperCase().trim()
  for (let i = 0; i < backupCodes.length; i++) {
    const code = backupCodes[i]
    if (code.used) continue
    const match = await bcrypt.compare(normalized, code.hash)
    if (match) {
      code.used = true
      return { matched: true, index: i, updated: backupCodes }
    }
  }
  return { matched: false }
}

// ─── Rate-limiting (per-IP, in-memory) ────────────────────────────────────────
// Map<ip → { count: number, lockedUntil: number | null }>
const _attempts = new Map()

const MAX_ATTEMPTS  = 5
const LOCK_DURATION = 15 * 60 * 1000  // 15 minutes

function checkRateLimit(ip) {
  const entry = _attempts.get(ip) || { count: 0, lockedUntil: null }

  if (entry.lockedUntil && Date.now() < entry.lockedUntil) {
    const remaining = Math.ceil((entry.lockedUntil - Date.now()) / 60000)
    return { blocked: true, remaining }
  }

  // Reset stale lock
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    entry.count       = 0
    entry.lockedUntil = null
  }

  return { blocked: false, count: entry.count }
}

function recordFailure(ip) {
  const entry = _attempts.get(ip) || { count: 0, lockedUntil: null }
  entry.count++
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCK_DURATION
  }
  _attempts.set(ip, entry)
}

function clearAttempts(ip) {
  _attempts.delete(ip)
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  encryptSecret,
  decryptSecret,
  generateSecret,
  verifyToken,
  generateBackupCodes,
  consumeBackupCode,
  checkRateLimit,
  recordFailure,
  clearAttempts,
}
