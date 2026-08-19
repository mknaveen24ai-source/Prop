process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-for-trigger-tests'
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://propfirm.example.com'

const { Pool } = require('pg')
const assert = require('node:assert/strict')

const { promotePassedAccount, fetchProgressionSettings } = require('../../services/progressionService')
const { approvePayout } = require('../../domain/payout')

const results = []
async function check(name, fn) {
  try { await fn(); results.push(['PASS', name]) }
  catch (error) { results.push(['FAIL', `${name} :: ${error.message}`]) }
}

async function makeTrader(db, email, name) {
  const res = await db.query(
    `INSERT INTO users (email, password_hash, full_name, country, kyc_status)
     VALUES ($1, 'x', $2, 'GB', 'approved')
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name, kyc_status = 'approved'
     RETURNING id, email, full_name`,
    [email, name]
  )
  return res.rows[0]
}

async function makeAccount(db, userId, { type, size = 100000, status = 'active' }) {
  const res = await db.query(
    `INSERT INTO accounts
       (user_id, account_type, account_size, current_balance, starting_balance,
        peak_balance, profit_target, max_drawdown_pct, status, phase_start_date)
     VALUES ($1, $2, $3, $3, $3, $3, 0, 10, $4, NOW())
     RETURNING *`,
    [userId, type, size, status]
  )
  return res.rows[0]
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const db = await pool.connect()

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to run trigger fixtures with NODE_ENV=production')
  }
  const settings = await fetchProgressionSettings()

  // ── Promotion: phase1 -> phase2 ────────────────────────────────────────────
  const trader = await makeTrader(db, 'trigger-promo@example.com', 'Wei Zhang')
  const phase1 = await makeAccount(db, trader.id, { type: 'phase1', size: 100000, status: 'passed' })

  let promotion = null
  await check('promoting a passed phase1 mints a phase_passed certificate', async () => {
    promotion = await promotePassedAccount(db, phase1, settings)
    assert.ok(promotion, 'promotion returned a result')
    assert.ok(promotion.new_account_id, 'a phase2 account was created')
    assert.ok(promotion.certificate, 'a certificate came back on the promotion result')
    assert.equal(promotion.certificate_created, true)
    assert.equal(promotion.certificate.kind, 'phase_passed')
    assert.equal(promotion.certificate.title, 'Phase 1 Challenge — $100,000')
    assert.equal(promotion.certificate.recipient_name, 'Wei Zhang')
    assert.equal(promotion.recipient_email, 'trigger-promo@example.com')
    assert.equal(String(promotion.certificate.source_key), `promotion:${promotion.new_account_id}`)
  })

  await check('the certificate is linked to the newly created account', async () => {
    assert.equal(String(promotion.certificate.account_id), String(promotion.new_account_id))
  })

  // ── Promotion: phase2 -> funded ────────────────────────────────────────────
  await check('promoting a passed phase2 mints a FUNDED certificate', async () => {
    const phase2 = await makeAccount(db, trader.id, { type: 'phase2', size: 250000, status: 'passed' })
    const funded = await promotePassedAccount(db, phase2, settings)
    assert.equal(funded.certificate.kind, 'funded')
    assert.equal(funded.certificate.title, '$250,000 Funded Trader')
    assert.equal(funded.certificate.amount, '250000.00')
  })

  // ── The headline safety property ───────────────────────────────────────────
  await check('a rolled-back promotion leaves no certificate', async () => {
    const doomed = await makeAccount(db, trader.id, { type: 'phase1', size: 75000, status: 'passed' })
    await db.query('BEGIN')
    const attempt = await promotePassedAccount(db, doomed, settings)
    const key = `promotion:${attempt.new_account_id}`
    await db.query('ROLLBACK')

    const found = await db.query(`SELECT COUNT(*)::int c FROM certificates WHERE source_key = $1`, [key])
    assert.equal(found.rows[0].c, 0, 'certificate must not survive the rollback')
    const account = await db.query(`SELECT COUNT(*)::int c FROM accounts WHERE id = $1`, [attempt.new_account_id])
    assert.equal(account.rows[0].c, 0, 'and neither must the account')
  })

  // ── Payout ─────────────────────────────────────────────────────────────────
  const payoutTrader = await makeTrader(db, 'trigger-payout@example.com', 'Sam Okafor')
  const fundedAccount = await makeAccount(db, payoutTrader.id, { type: 'funded', size: 100000 })
  await db.query(
    `UPDATE accounts SET current_balance = 110000, peak_balance = 110000,
            eod_peak_equity = 110000, min_trading_days = 0 WHERE id = $1`,
    [fundedAccount.id]
  )

  let payoutId = null
  await check('approving a payout mints a payout certificate', async () => {
    const payout = await db.query(
      `INSERT INTO payouts (user_id, account_id, amount_requested, amount_payable, payment_method, status)
       VALUES ($1, $2, 4500, 4500, 'usdt_trc20', 'pending') RETURNING id`,
      [payoutTrader.id, fundedAccount.id]
    )
    payoutId = payout.rows[0].id

    await db.query('BEGIN')
    const approval = await approvePayout(db, payoutId, { actor: 'admin:test' })
    await db.query('COMMIT')

    assert.equal(approval.payout.status, 'paid')
    assert.ok(approval.certificate, 'certificate returned from approvePayout')
    assert.equal(approval.certificateCreated, true)
    assert.equal(approval.certificate.kind, 'payout')
    assert.equal(approval.certificate.title, '$4,500 Profit Payout')
    assert.equal(approval.certificate.amount, '4500.00', 'amount matches amount_payable')
    assert.equal(approval.certificate.recipient_name, 'Sam Okafor')
    assert.equal(String(approval.certificate.source_key), `payout:${payoutId}`)
  })

  await check('a second approval of the same payout is refused, and mints nothing', async () => {
    const before = await db.query(`SELECT COUNT(*)::int c FROM certificates WHERE source_key = $1`, [`payout:${payoutId}`])
    await db.query('BEGIN')
    await assert.rejects(() => approvePayout(db, payoutId, { actor: 'admin:test' }), /Only pending payouts/)
    await db.query('ROLLBACK')
    const after = await db.query(`SELECT COUNT(*)::int c FROM certificates WHERE source_key = $1`, [`payout:${payoutId}`])
    assert.equal(after.rows[0].c, before.rows[0].c)
    assert.equal(after.rows[0].c, 1)
  })

  await check('a rolled-back payout approval leaves no certificate', async () => {
    const payout = await db.query(
      `INSERT INTO payouts (user_id, account_id, amount_requested, amount_payable, payment_method, status)
       VALUES ($1, $2, 1000, 1000, 'usdt_trc20', 'pending') RETURNING id`,
      [payoutTrader.id, fundedAccount.id]
    )
    const id = payout.rows[0].id

    await db.query('BEGIN')
    await approvePayout(db, id, { actor: 'admin:test' })
    await db.query('ROLLBACK')

    const found = await db.query(`SELECT COUNT(*)::int c FROM certificates WHERE source_key = $1`, [`payout:${id}`])
    assert.equal(found.rows[0].c, 0)
    const stillPending = await db.query(`SELECT status FROM payouts WHERE id = $1`, [id])
    assert.equal(stillPending.rows[0].status, 'pending', 'payout rolled back too')
  })

  // ── Certificates must never be the reason money movement fails ─────────────
  // Real fault injection rather than a stub: Postgres allows DDL inside a
  // transaction, so renaming the table makes the certificate INSERT genuinely
  // fail exactly where a broken renderer or a permissions problem would. That
  // is what the SAVEPOINT in awardPayoutCertificate exists to survive.
  await check('a failing certificate award does not block the payout', async () => {
    const payout = await db.query(
      `INSERT INTO payouts (user_id, account_id, amount_requested, amount_payable, payment_method, status)
       VALUES ($1, $2, 500, 500, 'usdt_trc20', 'pending') RETURNING id`,
      [payoutTrader.id, fundedAccount.id]
    )
    const id = payout.rows[0].id

    await db.query('BEGIN')
    await db.query('ALTER TABLE certificates RENAME TO certificates_hidden')

    const approval = await approvePayout(db, id, { actor: 'admin:test' })
    assert.equal(approval.payout.status, 'paid', 'payout still completes')
    assert.equal(approval.certificate, null, 'no certificate, reported honestly')
    assert.equal(approval.certificateCreated, false)

    // The transaction must still be usable — proof the savepoint contained the
    // failure instead of poisoning the whole approval.
    const stillLive = await db.query(`SELECT status FROM payouts WHERE id = $1`, [id])
    assert.equal(stillLive.rows[0].status, 'paid')

    await db.query('ROLLBACK')

    const restored = await db.query(
      `SELECT COUNT(*)::int c FROM information_schema.tables WHERE table_name = 'certificates'`
    )
    assert.equal(restored.rows[0].c, 1, 'table rename rolled back')
  })

  db.release()
  await pool.end()

  console.log('')
  for (const [state, name] of results) console.log(`  ${state}  ${name}`)
  const failed = results.filter(([s]) => s === 'FAIL').length
  console.log(`\n  ${results.length - failed}/${results.length} passed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
