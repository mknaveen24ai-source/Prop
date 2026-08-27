require('../loadEnv')

const knexFactory = require('knex')
const knexConfig = require('../knexfile')
const pool = require('../db')
const {
  getMissingProductionEnvVars,
  getUnsafeProductionEnvVars
} = require('../env')

const strict = process.env.DEPLOY_CHECK_STRICT === '1'
  || String(process.env.NODE_ENV || '').toLowerCase() === 'production'

function fail(failures, message) {
  failures.push(message)
  console.error(`FAIL  ${message}`)
}

function pass(message) {
  console.log(`PASS  ${message}`)
}

function warn(message) {
  console.warn(`WARN  ${message}`)
}

async function tableExists(tableName) {
  const result = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS exists`, [`public.${tableName}`])
  return result.rows[0]?.exists === true
}

async function checkMigrations(failures) {
  const envName = process.env.NODE_ENV === 'production' ? 'production' : 'development'
  const knex = knexFactory(knexConfig[envName])
  try {
    const [, pending] = await knex.migrate.list()
    if (pending.length > 0) {
      fail(failures, `Pending migrations: ${pending.map((migration) => migration.name || migration.file || migration).join(', ')}`)
    } else {
      pass('No pending migrations')
    }
  } finally {
    await knex.destroy()
  }
}

async function checkAdminState(failures) {
  if (!await tableExists('platform_admins')) {
    fail(failures, 'platform_admins table is missing; run migrations before deploy')
    return
  }

  const platform = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'active')::int AS active,
       COUNT(*) FILTER (WHERE status = 'active' AND totp_enabled = TRUE)::int AS active_totp
     FROM platform_admins`
  )

  const activePlatformAdmins = parseInt(platform.rows[0]?.active || 0, 10)
  const activePlatformAdminsWithTotp = parseInt(platform.rows[0]?.active_totp || 0, 10)

  if (activePlatformAdmins < 1) {
    fail(failures, 'At least one active DB-backed platform admin is required')
  } else {
    pass(`Active platform admins: ${activePlatformAdmins}`)
  }

  if (strict && activePlatformAdminsWithTotp < activePlatformAdmins) {
    fail(failures, `Platform admin 2FA incomplete: ${activePlatformAdminsWithTotp}/${activePlatformAdmins}`)
  } else {
    pass(`Platform admin 2FA coverage: ${activePlatformAdminsWithTotp}/${activePlatformAdmins}`)
  }
}

function checkEnvironment(failures) {
  const missing = getMissingProductionEnvVars()
  const unsafe = getUnsafeProductionEnvVars()

  if (strict && missing.length > 0) {
    fail(failures, `Missing production env vars: ${missing.join(', ')}`)
  } else if (missing.length > 0) {
    warn(`Production env vars not set in this environment: ${missing.join(', ')}`)
  } else {
    pass('Required production env vars are present')
  }

  if (strict && unsafe.length > 0) {
    fail(failures, `Unsafe production env vars: ${unsafe.join(', ')}`)
  } else if (unsafe.length > 0) {
    warn(`Values that would be unsafe in production: ${unsafe.join(', ')}`)
  } else {
    pass('Production secret/sender/proxy values look safe')
  }
}

/**
 * Report challenge models carrying two scaling semantics at once.
 *
 * challenge_models has both scaling_multiplier (doubling) and
 * scaling_increase_per_milestone_pct (a linear step). Only the linear one
 * governs — routes/accounts.js and challengeEngine.js both grant
 * starting_balance * increase_pct / 100 — but the doubling column is seeded on
 * every row, so a future reader picking the wrong one silently changes what a
 * funded trader is entitled to.
 *
 * A WARN rather than a FAIL, deliberately: the seeded values are a product
 * decision and preflight must not block a deploy over one. The point is that
 * the ambiguity is visible on every deploy rather than discovered from a payout
 * dispute. It also prints the ceiling, which is the number the firm has to be
 * able to honour.
 */
async function checkScalingConfiguration() {
  if (!await tableExists('challenge_models')) return

  const result = await pool.query(
    `SELECT slug, scaling_multiplier, scaling_increase_per_milestone_pct, scaling_max_account_size
       FROM challenge_models
      WHERE scaling_enabled = TRUE
        AND scaling_multiplier IS NOT NULL
        AND scaling_multiplier <> 1
        AND scaling_increase_per_milestone_pct IS NOT NULL
      ORDER BY slug`
  )

  if (result.rows.length === 0) {
    pass('Scaling models carry a single scaling formula')
    return
  }

  warn(
    `${result.rows.length} scaling model(s) carry BOTH scaling_multiplier and ` +
    'scaling_increase_per_milestone_pct. Only the linear increase governs; the multiplier is display-legacy.'
  )
  for (const row of result.rows) {
    const ceiling = row.scaling_max_account_size != null
      ? `$${Number(row.scaling_max_account_size).toLocaleString('en-US')}`
      : 'none'
    console.warn(
      `      ${row.slug}: governs +${row.scaling_increase_per_milestone_pct}% per milestone · ` +
      `ignored multiplier ${row.scaling_multiplier}x · ceiling ${ceiling}`
    )
  }
}

async function main() {
  const failures = []

  checkEnvironment(failures)
  await checkMigrations(failures)
  await checkAdminState(failures)
  await checkScalingConfiguration()

  if (failures.length > 0) {
    console.error(`\nDeployment preflight failed with ${failures.length} blocker(s).`)
    process.exitCode = 1
  } else {
    console.log('\nDeployment preflight passed.')
  }
}

main()
  .catch((error) => {
    console.error(`Deployment preflight error: ${error.message}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end().catch(() => {})
  })
