#!/usr/bin/env node
'use strict'
/**
 * Re-encrypt data-at-rest after an encryption key rotation (incident 2026-08-21)
 * ─────────────────────────────────────────────────────────────────────────────
 * SECRET_ROTATION_RUNBOOK.md §3 is explicit: KYC_FILE_ENCRYPTION_KEY and
 * TOTP_ENCRYPTION_KEY cannot simply be changed. Both encrypt data that already
 * exists, so a new key without a re-encryption pass makes that data unreadable.
 * The rotation was performed without this script existing. This is that script,
 * plus the audit that tells you whether the damage was already done.
 *
 *     node scripts/rotate-encryption-keys.js                  # audit, writes nothing
 *     node scripts/rotate-encryption-keys.js --scope=kyc
 *     node scripts/rotate-encryption-keys.js --apply          # re-encrypt
 *
 * RUN THE AUDIT FIRST. It is read-only and it answers the only question that
 * matters: is each record readable with the CURRENT key (nothing to do), with
 * some OLD key (recoverable — run --apply), or with neither (unrecoverable, and
 * you need backups).
 *
 * ── Old keys are supplied explicitly, never guessed ──────────────────────────
 * Set whichever apply, from the pre-rotation config (commit a7f610c):
 *
 *     OLD_KYC_FILE_ENCRYPTION_KEY   OLD_TOTP_ENCRYPTION_KEY
 *     OLD_ADMIN_JWT_SECRET          OLD_JWT_SECRET
 *
 * The two JWT secrets matter because secureKycStorage.getEncryptionKey() falls
 * back to `ADMIN_JWT_SECRET || JWT_SECRET` whenever NODE_ENV !== 'production'.
 * Any file written during a non-production boot is keyed to one of those
 * instead, so they are tried as candidates too (runbook §3.1).
 *
 * ── Why the two halves behave differently ────────────────────────────────────
 * KYC is AES-256-GCM: authenticated, so a wrong key fails loudly and "did this
 * decrypt" is a trustworthy question.
 *
 * TOTP is AES-256-CBC: unauthenticated. A wrong key yields plausible-looking
 * garbage or a padding error, never a clean failure — so this script supplies
 * the integrity check CBC lacks by requiring the plaintext to be a valid base32
 * TOTP secret. That check is the only thing standing between a rotation and
 * silently writing noise over every 2FA enrolment in the table.
 *
 * The crypto below deliberately re-implements the wire formats of
 * utils/secureKycStorage.js and utils/totp.js rather than importing them: both
 * read their key from the environment at call time (totp.js at module load),
 * which makes it impossible to hold an old and a new key open at once. The
 * formats are asserted against those modules in test/encryptionRotation.test.js
 * so this copy cannot drift silently.
 */

require('../loadEnv')

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

// ─── Wire formats (mirrors utils/secureKycStorage.js) ────────────────────────
const KYC_MAGIC = Buffer.from('KYCENC1\0')
const KYC_IV_LENGTH = 12
const KYC_TAG_LENGTH = 16

// ─── Wire formats (mirrors utils/totp.js) ────────────────────────────────────
const TOTP_ALGO = 'aes-256-cbc'
const TOTP_IV_BYTES = 16

// speakeasy emits RFC 4648 base32. This is the integrity oracle CBC does not
// give us — see the header. length:20 in generateSecret() produces 32 chars.
const BASE32_SECRET = /^[A-Z2-7]{16,128}={0,6}$/

const KYC_ROOT = path.join(__dirname, '..', 'uploads', 'kyc')

function kycKeyFrom(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest()
}

function kycDecrypt(fileBuffer, key) {
  if (!fileBuffer.subarray(0, KYC_MAGIC.length).equals(KYC_MAGIC)) {
    throw new Error('missing KYCENC1 header')
  }
  const ivStart = KYC_MAGIC.length
  const tagStart = ivStart + KYC_IV_LENGTH
  const cipherStart = tagStart + KYC_TAG_LENGTH
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, fileBuffer.subarray(ivStart, tagStart))
  decipher.setAuthTag(fileBuffer.subarray(tagStart, cipherStart))
  // GCM authenticates on final() — a wrong key throws here rather than
  // returning garbage. This is what makes the KYC audit trustworthy.
  return Buffer.concat([decipher.update(fileBuffer.subarray(cipherStart)), decipher.final()])
}

function kycEncrypt(plaintext, key) {
  const iv = crypto.randomBytes(KYC_IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([KYC_MAGIC, iv, cipher.getAuthTag(), ciphertext])
}

function totpKeyFrom(hex) {
  if (!hex || String(hex).length < 64) throw new Error('TOTP key must be >= 64 hex chars (32 bytes)')
  return Buffer.from(String(hex), 'hex')
}

function totpDecrypt(stored, key) {
  const [ivHex, ctHex] = String(stored || '').split(':')
  if (!ivHex || !ctHex) throw new Error('malformed "iv:ciphertext" value')
  const decipher = crypto.createDecipheriv(TOTP_ALGO, key, Buffer.from(ivHex, 'hex'))
  const plain = Buffer.concat([decipher.update(Buffer.from(ctHex, 'hex')), decipher.final()]).toString('utf8')
  // CBC will happily "succeed" on the wrong key. Only the shape check below
  // distinguishes a real secret from noise that survived padding validation.
  if (!BASE32_SECRET.test(plain)) throw new Error('decrypted to a non-base32 value')
  return plain
}

function totpEncrypt(plain, key) {
  const iv = crypto.randomBytes(TOTP_IV_BYTES)
  const cipher = crypto.createCipheriv(TOTP_ALGO, key, iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${enc.toString('hex')}`
}

/**
 * Builds the ordered candidate list for a scope. Index 0 is always the current
 * key, so "already re-encrypted" is detected before anything is rewritten and
 * re-running --apply is a no-op rather than a second round of damage.
 */
function buildCandidates(scope) {
  const out = []
  const add = (label, raw, derive) => {
    if (!raw) return
    try {
      out.push({ label, key: derive(raw) })
    } catch (err) {
      console.warn(`  ! skipping candidate ${label}: ${err.message}`)
    }
  }

  if (scope === 'kyc') {
    add('CURRENT KYC_FILE_ENCRYPTION_KEY', process.env.KYC_FILE_ENCRYPTION_KEY, kycKeyFrom)
    add('OLD_KYC_FILE_ENCRYPTION_KEY', process.env.OLD_KYC_FILE_ENCRYPTION_KEY, kycKeyFrom)
    // Non-production boots keyed files to these instead — runbook §3.1.
    add('OLD_ADMIN_JWT_SECRET (non-prod fallback)', process.env.OLD_ADMIN_JWT_SECRET, kycKeyFrom)
    add('OLD_JWT_SECRET (non-prod fallback)', process.env.OLD_JWT_SECRET, kycKeyFrom)
    add('CURRENT ADMIN_JWT_SECRET (non-prod fallback)', process.env.ADMIN_JWT_SECRET, kycKeyFrom)
    add('CURRENT JWT_SECRET (non-prod fallback)', process.env.JWT_SECRET, kycKeyFrom)
  } else {
    add('CURRENT TOTP_ENCRYPTION_KEY', process.env.TOTP_ENCRYPTION_KEY, totpKeyFrom)
    add('OLD_TOTP_ENCRYPTION_KEY', process.env.OLD_TOTP_ENCRYPTION_KEY, totpKeyFrom)
  }
  return out
}

function firstWorkingKey(candidates, attempt) {
  for (let i = 0; i < candidates.length; i++) {
    try {
      return { index: i, candidate: candidates[i], plaintext: attempt(candidates[i].key) }
    } catch {
      // Expected for every non-matching key — that is how identification works.
    }
  }
  return null
}

// ─── KYC files ───────────────────────────────────────────────────────────────

function collectEncFiles(dir) {
  if (!fs.existsSync(dir)) return []
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...collectEncFiles(full))
    else if (entry.name.toLowerCase().endsWith('.enc')) out.push(full)
  }
  return out
}

async function processKyc(apply) {
  console.log('\n━━━ KYC documents (AES-256-GCM) ━━━')
  console.log(`  root: ${KYC_ROOT}`)

  const candidates = buildCandidates('kyc')
  if (!candidates.length) {
    console.error('  ✗ No usable keys. Set KYC_FILE_ENCRYPTION_KEY (and OLD_* to recover).')
    return { failures: 1 }
  }
  console.log(`  candidate keys: ${candidates.map((c) => c.label).join(', ')}`)

  const files = collectEncFiles(KYC_ROOT)
  if (!files.length) {
    console.log('  → no .enc files found; nothing to do')
    console.log('    (on the production host this must be run against the "uploads" Docker volume)')
    return { failures: 0 }
  }

  const buckets = new Map()
  const unrecoverable = []
  const recoverable = []

  for (const file of files) {
    let buffer
    try {
      buffer = fs.readFileSync(file)
    } catch (err) {
      unrecoverable.push({ file, reason: `unreadable: ${err.message}` })
      continue
    }
    const hit = firstWorkingKey(candidates, (key) => kycDecrypt(buffer, key))
    if (!hit) {
      unrecoverable.push({ file, reason: 'no candidate key decrypts this file' })
      continue
    }
    buckets.set(hit.candidate.label, (buckets.get(hit.candidate.label) || 0) + 1)
    if (hit.index > 0) recoverable.push({ file, plaintext: hit.plaintext, via: hit.candidate.label })
  }

  console.log(`\n  ${files.length} encrypted file(s):`)
  for (const [label, count] of buckets) console.log(`    ${count.toString().padStart(5)}  ${label}`)
  if (unrecoverable.length) console.log(`    ${unrecoverable.length.toString().padStart(5)}  ✗ UNRECOVERABLE`)

  if (!apply) {
    if (recoverable.length) console.log(`\n  → ${recoverable.length} file(s) need re-encryption. Re-run with --apply.`)
    else if (!unrecoverable.length) console.log('\n  ✓ every file already uses the current key')
  } else if (recoverable.length) {
    const newKey = candidates[0].key
    let done = 0
    for (const item of recoverable) {
      // Backup, write to temp, fsync, atomic rename. A crash mid-pass leaves
      // either the old file or the new one, never a truncated one.
      const backup = `${item.file}.bak-${Date.now()}`
      const temp = `${item.file}.tmp-${process.pid}`
      try {
        fs.copyFileSync(item.file, backup)
        const fd = fs.openSync(temp, 'w', 0o600)
        fs.writeSync(fd, kycEncrypt(item.plaintext, newKey))
        fs.fsyncSync(fd)
        fs.closeSync(fd)
        // Prove the rewrite is readable with the new key BEFORE it replaces the
        // original. GCM makes this verification meaningful.
        kycDecrypt(fs.readFileSync(temp), newKey)
        fs.renameSync(temp, item.file)
        done++
      } catch (err) {
        console.error(`    ✗ ${path.basename(item.file)}: ${err.message} (original intact; backup ${path.basename(backup)})`)
        if (fs.existsSync(temp)) fs.unlinkSync(temp)
      }
    }
    console.log(`\n  ✓ re-encrypted ${done}/${recoverable.length} file(s); .bak copies retained`)
  }

  if (unrecoverable.length) {
    console.error(`\n  ✗ ${unrecoverable.length} file(s) decrypt with NO known key:`)
    for (const item of unrecoverable.slice(0, 10)) {
      console.error(`      ${path.relative(KYC_ROOT, item.file)} — ${item.reason}`)
    }
    if (unrecoverable.length > 10) console.error(`      … and ${unrecoverable.length - 10} more`)
    console.error('    Supply the correct OLD_* key, or restore these from backup.')
    console.error('    These are identity documents — affected users must re-submit if unrecoverable.')
  }

  return { failures: unrecoverable.length }
}

// ─── TOTP secrets ────────────────────────────────────────────────────────────

// All three locations named in runbook §3.2. Missing tables are tolerated —
// the legacy platform_settings row does not exist on newer deployments.
const TOTP_LOCATIONS = [
  { label: 'users.totp_secret', table: 'users', column: 'totp_secret', idColumn: 'id' },
  { label: 'platform_admins.totp_secret', table: 'platform_admins', column: 'totp_secret', idColumn: 'id' },
  { label: "platform_settings['admin_totp_secret']", table: 'platform_settings', column: 'value', idColumn: 'key', filter: "key = 'admin_totp_secret'" }
]

async function processTotp(pool, apply) {
  console.log('\n━━━ TOTP secrets (AES-256-CBC, unauthenticated) ━━━')

  const candidates = buildCandidates('totp')
  if (!candidates.length) {
    console.error('  ✗ No usable keys. Set TOTP_ENCRYPTION_KEY (and OLD_TOTP_ENCRYPTION_KEY to recover).')
    return { failures: 1 }
  }
  console.log(`  candidate keys: ${candidates.map((c) => c.label).join(', ')}`)

  let totalUnrecoverable = 0

  for (const loc of TOTP_LOCATIONS) {
    const where = `${loc.column} IS NOT NULL AND ${loc.column} <> ''${loc.filter ? ` AND ${loc.filter}` : ''}`
    let rows
    try {
      const result = await pool.query(`SELECT ${loc.idColumn} AS id, ${loc.column} AS secret FROM ${loc.table} WHERE ${where}`)
      rows = result.rows
    } catch (err) {
      if (err.code === '42P01' || err.code === '42703') {
        console.log(`  ─ ${loc.label}: not present on this deployment, skipped`)
        continue
      }
      throw err
    }

    if (!rows.length) {
      console.log(`  ─ ${loc.label}: no enrolments`)
      continue
    }

    const buckets = new Map()
    const stale = []
    const broken = []

    for (const row of rows) {
      const hit = firstWorkingKey(candidates, (key) => totpDecrypt(row.secret, key))
      if (!hit) {
        broken.push(row.id)
        continue
      }
      buckets.set(hit.candidate.label, (buckets.get(hit.candidate.label) || 0) + 1)
      if (hit.index > 0) stale.push({ id: row.id, plaintext: hit.plaintext })
    }

    console.log(`  ─ ${loc.label}: ${rows.length} enrolment(s)`)
    for (const [label, count] of buckets) console.log(`      ${count.toString().padStart(5)}  ${label}`)
    if (broken.length) console.log(`      ${broken.length.toString().padStart(5)}  ✗ UNRECOVERABLE`)

    if (apply && stale.length) {
      const newKey = candidates[0].key
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        for (const item of stale) {
          const reencrypted = totpEncrypt(item.plaintext, newKey)
          // Round-trip before the row is written. CBC gives no integrity
          // guarantee, so this is the only thing proving the write is good.
          if (totpDecrypt(reencrypted, newKey) !== item.plaintext) {
            throw new Error(`round-trip verification failed for ${loc.label} id=${item.id}`)
          }
          await client.query(
            `UPDATE ${loc.table} SET ${loc.column} = $1 WHERE ${loc.idColumn} = $2`,
            [reencrypted, item.id]
          )
        }
        await client.query('COMMIT')
        console.log(`      ✓ re-encrypted ${stale.length} secret(s)`)
      } catch (err) {
        await client.query('ROLLBACK')
        console.error(`      ✗ rolled back, no rows changed: ${err.message}`)
        totalUnrecoverable++
      } finally {
        client.release()
      }
    } else if (stale.length) {
      console.log(`      → ${stale.length} secret(s) need re-encryption. Re-run with --apply.`)
    }

    if (broken.length) {
      totalUnrecoverable += broken.length
      console.error(`      ✗ ids with no working key: ${broken.slice(0, 10).join(', ')}${broken.length > 10 ? ` … +${broken.length - 10}` : ''}`)
      console.error('        Runbook §3.2 fallback: clear these, disable 2FA, have the users re-enrol.')
      console.error('        Email them first — silently breaking a login looks like a compromise.')
    }
  }

  return { failures: totalUnrecoverable }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const scopeArg = (args.find((a) => a.startsWith('--scope=')) || '--scope=all').split('=')[1]

  if (!['all', 'kyc', 'totp'].includes(scopeArg)) {
    console.error(`Unknown --scope=${scopeArg} (expected: all, kyc, totp)`)
    process.exit(2)
  }

  console.log(apply ? '\n*** APPLY MODE — this rewrites data ***' : '\n=== AUDIT MODE — read-only, nothing is written ===')
  if (apply) console.log('Take a database backup and snapshot the uploads volume before continuing.')

  let failures = 0
  let pool = null

  try {
    if (scopeArg === 'all' || scopeArg === 'kyc') {
      failures += (await processKyc(apply)).failures
    }
    if (scopeArg === 'all' || scopeArg === 'totp') {
      pool = require('../db')
      failures += (await processTotp(pool, apply)).failures
    }
  } finally {
    if (pool) await pool.end().catch(() => {})
  }

  if (failures > 0) {
    console.error(`\n✗ ${failures} record(s) could not be recovered with any supplied key.`)
    console.error('  Supply the correct OLD_* values, or restore from backup. Do not ignore this.')
    process.exit(1)
  }

  console.log(apply ? '\n✓ Re-encryption complete.' : '\n✓ Audit complete — no unrecoverable records.')
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n✗ Fatal:', err.message)
    process.exit(1)
  })
}

module.exports = { kycEncrypt, kycDecrypt, kycKeyFrom, totpEncrypt, totpDecrypt, totpKeyFrom, BASE32_SECRET }
