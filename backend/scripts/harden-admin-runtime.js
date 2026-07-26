#!/usr/bin/env node

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const bcrypt = require('bcryptjs')
const { Pool } = require('pg')

require('../loadEnv')

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const part = String(argv[i] || '')
    if (!part.startsWith('--')) continue
    const key = part.slice(2)
    const next = argv[i + 1]
    if (!next || String(next).startsWith('--')) {
      args[key] = true
    } else {
      args[key] = next
      i += 1
    }
  }
  return args
}

function randomBase64Url(bytes = 48) {
  return crypto.randomBytes(bytes).toString('base64url')
}

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex')
}

function upsertEnvValue(content, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`^${escapedKey}=.*$`, 'm')
  const line = `${key}=${value}`
  if (pattern.test(content)) {
    return content.replace(pattern, line)
  }
  const trimmed = content.endsWith('\n') ? content : `${content}\n`
  return `${trimmed}${line}\n`
}

async function ensurePlatformAdminsTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS platform_admins (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'super_admin',
      status TEXT NOT NULL DEFAULT 'active',
      token_version INTEGER NOT NULL DEFAULT 1,
      totp_secret TEXT,
      totp_temp_secret TEXT,
      totp_backup_codes TEXT,
      totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      last_login_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_platform_admins_status_email ON platform_admins(status, email)`)
}

async function getExistingPlatformAdmin(pool, email) {
  const result = await pool.query(
    `SELECT id, email, status, token_version, totp_enabled
       FROM platform_admins
      WHERE LOWER(email) = LOWER($1)
      LIMIT 1`,
    [email]
  )
  return result.rows[0] || null
}

async function getActiveOrEnrolledAdminCounts(pool) {
  const platform = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active')::int AS active,
       COUNT(*) FILTER (WHERE totp_enabled = TRUE)::int AS totp_enabled
     FROM platform_admins`
  )

  return {
    activePlatformAdmins: parseInt(platform.rows[0]?.active || 0, 10) || 0,
    activePlatformAdminsWithTotp: parseInt(platform.rows[0]?.totp_enabled || 0, 10) || 0
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const email = String(args.email || 'admin@propfirm.local').trim().toLowerCase()
  const fullName = String(args.name || 'Platform Owner').trim()
  const password = String(args.password || randomBase64Url(18))
  const envPath = path.resolve(__dirname, '../.env')

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('A valid admin email is required')
  }
  if (fullName.length < 2) {
    throw new Error('A valid admin full name is required')
  }
  if (password.length < 16) {
    throw new Error('Admin password must be at least 16 characters')
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })

  try {
    await ensurePlatformAdminsTable(pool)

    const counts = await getActiveOrEnrolledAdminCounts(pool)
    const activeCount = counts.activePlatformAdmins
    const existingAdmin = await getExistingPlatformAdmin(pool, email)

    let createdAdmin = false
    let reactivatedAdmin = false
    if (activeCount === 0 && existingAdmin && existingAdmin.status !== 'active') {
      const passwordHash = await bcrypt.hash(password, 12)
      await pool.query(
        `UPDATE platform_admins
            SET full_name = $2,
                password_hash = $3,
                status = 'active',
                token_version = COALESCE(token_version, 1) + 1,
                updated_at = NOW()
          WHERE id = $1`,
        [existingAdmin.id, fullName, passwordHash]
      )
      reactivatedAdmin = true
    } else if (activeCount === 0 && !existingAdmin) {
      const passwordHash = await bcrypt.hash(password, 12)
      await pool.query(
        `INSERT INTO platform_admins
          (email, full_name, password_hash, role, status, token_version, totp_enabled, created_at, updated_at)
         VALUES (LOWER($1), $2, $3, 'super_admin', 'active', 1, FALSE, NOW(), NOW())`,
        [email, fullName, passwordHash]
      )
      createdAdmin = true
    }

    const rotated = {
      JWT_SECRET: randomBase64Url(48),
      ADMIN_JWT_SECRET: randomBase64Url(48),
      ADMIN_PASSWORD: await bcrypt.hash(randomBase64Url(24), 12)
    }

    const enrolledTotpAdmins = counts.activePlatformAdminsWithTotp
    const shouldRotateTotpKey = enrolledTotpAdmins === 0 || args['force-rotate-totp-key'] === true
    if (shouldRotateTotpKey) {
      rotated.TOTP_ENCRYPTION_KEY = randomHex(32)
    }

    let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''
    for (const [key, value] of Object.entries(rotated)) {
      envContent = upsertEnvValue(envContent, key, value)
    }
    fs.writeFileSync(envPath, envContent, 'utf8')

    const verification = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'active')::int AS active,
              COUNT(*) FILTER (WHERE status = 'active' AND totp_enabled = TRUE)::int AS totp_enabled
         FROM platform_admins`
    )

    const summary = {
      envPath,
      admin_created: createdAdmin,
      admin_reactivated: reactivatedAdmin,
      bootstrap_email: createdAdmin || reactivatedAdmin ? email : null,
      bootstrap_password: createdAdmin || reactivatedAdmin ? password : null,
      platform_admins: verification.rows[0],
      secrets_rotated: Object.keys(rotated),
      totp_key_rotated: shouldRotateTotpKey,
      active_totp_enrollments: enrolledTotpAdmins,
      restart_required: true
    }

    console.log(JSON.stringify(summary, null, 2))
  } finally {
    await pool.end().catch(() => {})
  }
}

main().catch((error) => {
  console.error(error.message || String(error))
  process.exitCode = 1
})
