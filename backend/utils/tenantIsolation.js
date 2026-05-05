const pool = require('../db')
const logger = require('./logger')
const { runWithSystemDbContext } = require('./dbContext')
const { ensureTenantInfrastructure } = require('./tenants')
const { ensureTenantSettingsInfrastructure } = require('./tenantSettings')
const { ensureTenantFeedInfrastructure } = require('./tenantFeeds')
const { ensureBillingInfrastructure } = require('../routes/billing')
const { ensureChatTables } = require('../routes/chat')
const { ensureDisputesInfrastructure } = require('../routes/disputes')
const { ensureViolationTables } = require('../services/violationEngine')

let tenantIsolationPromise = null

const TENANT_ID_TABLES = [
  'users',
  'accounts',
  'trades',
  'payouts',
  'support_tickets',
  'support_ticket_messages',
  'chat_conversations',
  'chat_messages',
  'disputes',
  'trade_logs',
  'login_logs',
  'bbook_pnl',
  'admin_rule_violations',
  'admin_enforcement_events',
  'admin_balance_adjustments',
  'admin_immutable_audit',
  'admin_four_eyes_requests',
  'admin_notifications',
  'admin_cases',
  'admin_dispute_meta',
  'admin_scheduled_reports',
  'challenge_products',
  'challenge_orders',
  'challenge_payments',
  'challenge_checkout_sessions',
  'tenant_settings',
  'tenant_admins',
  'tenant_price_feeds',
  'tenant_subscriptions',
  'tenant_subscription_events'
]

const RLS_TABLES = [
  'users',
  'accounts',
  'trades',
  'payouts',
  'support_tickets',
  'support_ticket_messages',
  'chat_conversations',
  'chat_messages',
  'disputes',
  'trade_logs',
  'login_logs',
  'bbook_pnl',
  'admin_rule_violations',
  'admin_enforcement_events',
  'admin_balance_adjustments',
  'admin_immutable_audit',
  'admin_four_eyes_requests',
  'admin_notifications',
  'admin_cases',
  'admin_dispute_meta',
  'admin_scheduled_reports',
  'challenge_products',
  'challenge_orders',
  'challenge_payments',
  'challenge_checkout_sessions',
  'tenant_settings',
  'tenant_admins',
  'tenant_price_feeds',
  'tenant_subscriptions',
  'tenant_subscription_events'
]

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT to_regclass($1) IS NOT NULL AS exists`,
    [`public.${tableName}`]
  )
  return result.rows[0]?.exists === true
}

async function ensureTenantIdColumn(tableName, { notNull = false } = {}) {
  if (!await tableExists(tableName)) return

  await pool.query(`ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS tenant_id BIGINT`)
  await pool.query(
    `ALTER TABLE ${tableName}
        ALTER COLUMN tenant_id
        SET DEFAULT NULLIF(current_setting('app.current_tenant_id', true), '')::bigint`
  )
  if (notNull) {
    await pool.query(`UPDATE ${tableName} SET tenant_id = 1 WHERE tenant_id IS NULL`)
    await pool.query(`ALTER TABLE ${tableName} ALTER COLUMN tenant_id SET NOT NULL`)
  }
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_${tableName}_tenant_id ON ${tableName}(tenant_id)`)
}

async function backfillTenantColumns() {
  await pool.query(`UPDATE users SET tenant_id = 1 WHERE tenant_id IS NULL`)
  await pool.query(`UPDATE accounts SET tenant_id = COALESCE(tenant_id, 1) WHERE tenant_id IS NULL`)

  if (await tableExists('trades')) {
    await pool.query(
      `UPDATE trades t
          SET tenant_id = COALESCE(t.tenant_id, a.tenant_id, u.tenant_id, 1)
         FROM accounts a
         LEFT JOIN users u ON u.id::text = a.user_id::text
        WHERE t.account_id::text = a.id::text
          AND t.tenant_id IS NULL`
    )
    await pool.query(`UPDATE trades SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('payouts')) {
    await pool.query(
      `WITH resolved AS (
         SELECT p.id,
                COALESCE(p.tenant_id, a.tenant_id, u.tenant_id, 1) AS resolved_tenant_id
           FROM payouts p
           LEFT JOIN accounts a ON a.id::text = p.account_id::text
           LEFT JOIN users u ON u.id::text = p.user_id::text
          WHERE p.tenant_id IS NULL
       )
       UPDATE payouts p
          SET tenant_id = resolved.resolved_tenant_id
         FROM resolved
        WHERE p.id = resolved.id`
    )
    await pool.query(`UPDATE payouts SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('support_tickets')) {
    await pool.query(
      `UPDATE support_tickets st
          SET tenant_id = COALESCE(st.tenant_id, u.tenant_id, 1)
         FROM users u
        WHERE st.user_id::text = u.id::text
          AND st.tenant_id IS NULL`
    )
    await pool.query(`UPDATE support_tickets SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('support_ticket_messages')) {
    await pool.query(
      `UPDATE support_ticket_messages stm
          SET tenant_id = COALESCE(stm.tenant_id, st.tenant_id, 1)
         FROM support_tickets st
        WHERE stm.ticket_id = st.id
          AND stm.tenant_id IS NULL`
    )
    await pool.query(`UPDATE support_ticket_messages SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('chat_conversations')) {
    await pool.query(
      `UPDATE chat_conversations c
          SET tenant_id = COALESCE(c.tenant_id, u.tenant_id, 1)
         FROM users u
        WHERE c.user_id::text = u.id::text
          AND c.tenant_id IS NULL`
    )
    await pool.query(`UPDATE chat_conversations SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('chat_messages')) {
    await pool.query(
      `UPDATE chat_messages m
          SET tenant_id = COALESCE(m.tenant_id, c.tenant_id, 1)
         FROM chat_conversations c
        WHERE m.conversation_id = c.id
          AND m.tenant_id IS NULL`
    )
    await pool.query(`UPDATE chat_messages SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('disputes')) {
    await pool.query(
      `UPDATE disputes d
          SET tenant_id = COALESCE(d.tenant_id, a.tenant_id, u.tenant_id, 1)
         FROM accounts a
         LEFT JOIN users u ON u.id::text = a.user_id::text
        WHERE d.account_id::text = a.id::text
          AND d.tenant_id IS NULL`
    )
    await pool.query(
      `UPDATE disputes d
          SET tenant_id = COALESCE(d.tenant_id, u.tenant_id, 1)
         FROM users u
        WHERE d.user_id::text = u.id::text
          AND d.tenant_id IS NULL`
    )
    await pool.query(`UPDATE disputes SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('trade_logs')) {
    await pool.query(
      `UPDATE trade_logs tl
          SET tenant_id = COALESCE(tl.tenant_id, a.tenant_id, u.tenant_id, 1)
         FROM accounts a
         LEFT JOIN users u ON u.id::text = a.user_id::text
        WHERE tl.account_id::text = a.id::text
          AND tl.tenant_id IS NULL`
    )
    await pool.query(
      `UPDATE trade_logs tl
          SET tenant_id = COALESCE(tl.tenant_id, u.tenant_id, 1)
         FROM users u
        WHERE tl.user_id::text = u.id::text
          AND tl.tenant_id IS NULL`
    )
    await pool.query(`UPDATE trade_logs SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('login_logs')) {
    await pool.query(
      `UPDATE login_logs ll
          SET tenant_id = COALESCE(ll.tenant_id, u.tenant_id, 1)
         FROM users u
        WHERE ll.user_id::text = u.id::text
          AND ll.tenant_id IS NULL`
    )
    await pool.query(`UPDATE login_logs SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('admin_rule_violations')) {
    await pool.query(
      `UPDATE admin_rule_violations v
          SET tenant_id = COALESCE(v.tenant_id, a.tenant_id, u.tenant_id, 1)
         FROM accounts a
         LEFT JOIN users u ON u.id::text = a.user_id::text
        WHERE v.account_id::text = a.id::text
          AND v.tenant_id IS NULL`
    )
    await pool.query(
      `UPDATE admin_rule_violations v
          SET tenant_id = COALESCE(v.tenant_id, u.tenant_id, 1)
         FROM users u
        WHERE v.user_id::text = u.id::text
          AND v.tenant_id IS NULL`
    )
    await pool.query(`UPDATE admin_rule_violations SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('admin_enforcement_events')) {
    await pool.query(
      `UPDATE admin_enforcement_events e
          SET tenant_id = COALESCE(e.tenant_id, a.tenant_id, u.tenant_id, 1)
         FROM accounts a
         LEFT JOIN users u ON u.id::text = a.user_id::text
        WHERE e.account_id::text = a.id::text
          AND e.tenant_id IS NULL`
    )
    await pool.query(
      `UPDATE admin_enforcement_events e
          SET tenant_id = COALESCE(e.tenant_id, u.tenant_id, 1)
         FROM users u
        WHERE e.user_id::text = u.id::text
          AND e.tenant_id IS NULL`
    )
    await pool.query(`UPDATE admin_enforcement_events SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('admin_balance_adjustments')) {
    await pool.query(
      `UPDATE admin_balance_adjustments aba
          SET tenant_id = COALESCE(aba.tenant_id, a.tenant_id, u.tenant_id, 1)
         FROM accounts a
         LEFT JOIN users u ON u.id::text = a.user_id::text
        WHERE aba.account_id::text = a.id::text
          AND aba.tenant_id IS NULL`
    )
    await pool.query(`UPDATE admin_balance_adjustments SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('admin_dispute_meta')) {
    await pool.query(
      `UPDATE admin_dispute_meta adm
          SET tenant_id = COALESCE(adm.tenant_id, d.tenant_id, 1)
         FROM disputes d
        WHERE adm.dispute_id::text = d.id::text
          AND adm.tenant_id IS NULL`
    )
  }

  if (await tableExists('challenge_payments')) {
    await pool.query(
      `UPDATE challenge_payments cp
          SET tenant_id = COALESCE(cp.tenant_id, co.tenant_id, 1)
         FROM challenge_orders co
        WHERE cp.order_id = co.id
          AND cp.tenant_id IS NULL`
    )
    await pool.query(`UPDATE challenge_payments SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('challenge_checkout_sessions')) {
    await pool.query(
      `UPDATE challenge_checkout_sessions ccs
          SET tenant_id = COALESCE(ccs.tenant_id, co.tenant_id, 1)
         FROM challenge_orders co
        WHERE ccs.order_id = co.id
          AND ccs.tenant_id IS NULL`
    )
    await pool.query(`UPDATE challenge_checkout_sessions SET tenant_id = 1 WHERE tenant_id IS NULL`)
  }

  if (await tableExists('tenant_subscription_events')) {
    await pool.query(
      `UPDATE tenant_subscription_events tse
          SET tenant_id = COALESCE(tse.tenant_id, ts.tenant_id, 1)
         FROM tenant_subscriptions ts
        WHERE tse.tenant_subscription_id = ts.id
          AND tse.tenant_id IS NULL`
    )
  }
}

async function ensureRlsPolicy(tableName) {
  if (!await tableExists(tableName)) return

  await pool.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`)
  await pool.query(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`)

  const usingClause = `
    current_setting('app.bypass_rls', true) = 'true'
    OR tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::bigint
  `

  await pool.query(`DROP POLICY IF EXISTS ${tableName}_tenant_scope ON ${tableName}`)
  await pool.query(
    `CREATE POLICY ${tableName}_tenant_scope ON ${tableName}
      USING (${usingClause})
      WITH CHECK (${usingClause})`
  )
}

async function ensureTenantIsolationInfrastructure() {
  if (tenantIsolationPromise) return tenantIsolationPromise

  tenantIsolationPromise = runWithSystemDbContext(async () => {
    await ensureTenantInfrastructure()
    await ensureTenantSettingsInfrastructure()
    await ensureTenantFeedInfrastructure()
    await ensureBillingInfrastructure()
    await ensureChatTables()
    await ensureDisputesInfrastructure()
    await ensureViolationTables()

    for (const tableName of TENANT_ID_TABLES) {
      await ensureTenantIdColumn(tableName, {
        notNull: [
          'challenge_products',
          'challenge_orders',
          'challenge_payments',
          'challenge_checkout_sessions',
          'tenant_settings',
          'tenant_admins',
          'tenant_price_feeds',
          'tenant_subscriptions'
        ].includes(tableName)
      })
    }

    await backfillTenantColumns()

    for (const tableName of RLS_TABLES) {
      await ensureRlsPolicy(tableName)
    }
  }).catch((error) => {
    tenantIsolationPromise = null
    logger.error('[tenant-isolation] Failed to ensure tenant isolation:', { error: error.message })
    throw error
  })

  return tenantIsolationPromise
}

module.exports = {
  TENANT_ID_TABLES,
  RLS_TABLES,
  ensureTenantIsolationInfrastructure
}
