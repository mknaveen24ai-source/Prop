require('../loadEnv')

const pool = require('../db')
const { TENANT_ID_TABLES, RLS_TABLES } = require('../utils/tenantIsolation')

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${tableName}`]
  )
  return result.rows[0]?.exists === true
}

async function hasTenantIdColumn(tableName) {
  const result = await pool.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = $1
        AND column_name = 'tenant_id'
      LIMIT 1`,
    [tableName]
  )
  return result.rows.length > 0
}

async function getRlsState(tableName) {
  const result = await pool.query(
    `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class
      WHERE oid = to_regclass($1)`,
    [`public.${tableName}`]
  )
  return result.rows[0] || null
}

async function hasTenantScopePolicy(tableName) {
  const result = await pool.query(
    `SELECT 1
       FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = $1
        AND policyname = $2
      LIMIT 1`,
    [tableName, `${tableName}_tenant_scope`]
  )
  return result.rows.length > 0
}

async function main() {
  const failures = []

  for (const tableName of TENANT_ID_TABLES) {
    if (!await tableExists(tableName)) {
      failures.push(`${tableName}: table_missing`)
      continue
    }
    if (!await hasTenantIdColumn(tableName)) {
      failures.push(`${tableName}: missing_tenant_id`)
    }
  }

  for (const tableName of RLS_TABLES) {
    if (!await tableExists(tableName)) {
      failures.push(`${tableName}: table_missing_for_rls`)
      continue
    }

    const rls = await getRlsState(tableName)
    if (!rls?.relrowsecurity) {
      failures.push(`${tableName}: rls_disabled`)
    }
    if (!rls?.relforcerowsecurity) {
      failures.push(`${tableName}: rls_not_forced`)
    }
    if (!await hasTenantScopePolicy(tableName)) {
      failures.push(`${tableName}: tenant_scope_policy_missing`)
    }
  }

  if (failures.length > 0) {
    console.error('Tenant isolation verification failed:')
    failures.forEach((failure) => console.error(` - ${failure}`))
    process.exitCode = 1
  } else {
    console.log(`Tenant isolation verified for ${RLS_TABLES.length} RLS tables and ${TENANT_ID_TABLES.length} tenant-scoped tables.`)
  }
}

main()
  .catch((error) => {
    console.error('Tenant isolation verification error:', error.message)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end().catch(() => {})
  })
