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

async function main() {
  const failures = []

  checkEnvironment(failures)
  await checkMigrations(failures)
  await checkAdminState(failures)

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
