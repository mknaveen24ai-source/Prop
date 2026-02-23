const pool = require('./db')
require('dotenv').config()

async function runChallengeEngine() {
  try {
    const activeAccounts = await pool.query(
      `SELECT * FROM accounts WHERE status = 'active'`
    )

    for (const acc of activeAccounts.rows) {
      const current_balance = parseFloat(acc.current_balance)
      const starting_balance = parseFloat(acc.starting_balance)
      const peak_balance = parseFloat(acc.peak_balance)
      const max_drawdown_pct = parseFloat(acc.max_drawdown_pct)

      const profit_pct = ((current_balance - starting_balance) / starting_balance) * 100
      const drawdown_pct = ((peak_balance - current_balance) / peak_balance) * 100
      const days_elapsed = Math.floor((new Date() - new Date(acc.phase_start_date)) / (1000 * 60 * 60 * 24))

      if (drawdown_pct >= max_drawdown_pct) {
        await failAccount(acc, 'Max drawdown reached')
        continue
      }

      if (acc.account_type === 'phase1' && profit_pct >= 10) {
        await passPhase1(acc)
        continue
      }

      if (acc.account_type === 'phase2' && profit_pct >= 10) {
        await passPhase2(acc)
        continue
      }

      if (days_elapsed >= 30 && profit_pct < 10) {
        await expireAccount(acc)
        continue
      }
    }

    console.log('Challenge engine ran:', new Date().toISOString())

  } catch (error) {
    console.error('Challenge engine error:', error.message)
  }
}

async function failAccount(acc, reason) {
  await pool.query(
    `UPDATE accounts SET status = 'failed' WHERE id = $1`,
    [acc.id]
  )

  await pool.query(
    `UPDATE trades SET status = 'closed', close_time = NOW() 
     WHERE account_id = $1 AND status = 'open'`,
    [acc.id]
  )

  await pool.query(
    `UPDATE bbook_pnl SET accounts_failed = accounts_failed + 1
     WHERE date = CURRENT_DATE`,
  )

  console.log(`Account ${acc.id} FAILED — ${reason}`)
}

async function passPhase1(acc) {
  await pool.query(
    `UPDATE accounts SET status = 'passed' WHERE id = $1`,
    [acc.id]
  )

  const phase_end_date = new Date()
  phase_end_date.setDate(phase_end_date.getDate() + 30)

  await pool.query(
    `INSERT INTO accounts
     (user_id, account_type, account_size, current_balance, starting_balance,
      peak_balance, profit_target, max_drawdown_pct, status,
      phase_start_date, phase_end_date, bridge_mode)
     VALUES ($1, 'phase2', $2, $2, $2, $2, $3, 10, 'active', NOW(), $4, 'reverse')`,
    [
      acc.user_id,
      acc.account_size,
      acc.account_size * 0.10,
      phase_end_date
    ]
  )

  await pool.query(
    `UPDATE bbook_pnl SET accounts_passed = accounts_passed + 1
     WHERE date = CURRENT_DATE`,
  )

  console.log(`Account ${acc.id} PASSED Phase 1 — Phase 2 created`)
}

async function passPhase2(acc) {
  await pool.query(
    `UPDATE accounts SET status = 'passed' WHERE id = $1`,
    [acc.id]
  )

  await pool.query(
    `INSERT INTO accounts
     (user_id, account_type, account_size, current_balance, starting_balance,
      peak_balance, profit_target, max_drawdown_pct, status,
      phase_start_date, bridge_mode)
     VALUES ($1, 'funded', $2, $2, $2, $2, $3, 5, 'active', NOW(), 'copy')`,
    [
      acc.user_id,
      acc.account_size,
      acc.account_size * 0.10
    ]
  )

  await pool.query(
    `UPDATE bbook_pnl SET new_funded = new_funded + 1
     WHERE date = CURRENT_DATE`,
  )

  console.log(`Account ${acc.id} PASSED Phase 2 — Funded account created`)
}

async function expireAccount(acc) {
  await pool.query(
    `UPDATE accounts SET status = 'expired' WHERE id = $1`,
    [acc.id]
  )

  await pool.query(
    `UPDATE bbook_pnl SET accounts_expired = accounts_expired + 1
     WHERE date = CURRENT_DATE`,
  )

  console.log(`Account ${acc.id} EXPIRED — time limit reached`)
}

module.exports = { runChallengeEngine }
