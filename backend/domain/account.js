/**
 * Account aggregate — the chokepoint for non-trade balance and status changes.
 *
 * ── What belongs here, and what does not ──
 *
 * The governing invariant, documented at utils/balanceAdjustments.js:6-10 and
 * again at challengeEngine.js:517:
 *
 *   current_balance = starting_balance
 *                   + SUM(realised trade P&L)
 *                   + SUM(balance_adjustments.amount)
 *
 * So there are exactly two kinds of writer, and they must stay separate:
 *
 *   - Trading P&L (routes/trades/close.js, routes/trades/batch.js,
 *     services/tradeEngine.js, the force-close services). These are the middle
 *     term. They keep writing `current_balance` directly and must NOT be routed
 *     through this aggregate — putting them in the ledger would double-count
 *     them against the invariant.
 *
 *   - Everything else: admin adjustments, payout debits, competition
 *     corrections, scaling injections. These are the third term, and they all
 *     belong here.
 *
 * Before this existed, `accounts.current_balance` had fifteen independent
 * raw-SQL write paths and there were two divergent ledgers, so the invariant
 * held only by accident.
 *
 * ── Transaction contract ──
 *
 * Every command takes an already-open transaction client, matching
 * applyBalanceAdjustment's contract (utils/balanceAdjustments.js:24-26). The
 * aggregate never opens, commits or rolls back a transaction — callers compose
 * it with their own statements atomically. Use utils/withTransaction.js.
 */

const { applyBalanceAdjustment } = require('../utils/balanceAdjustments')
const { shiftAnchors, rebaseAnchors } = require('./drawdownAnchors')
const { evaluatePayoutEligibility } = require('./payoutEligibility')
const { DomainError, InvariantViolation, NotFound } = require('./errors')

const ACCOUNT_COLUMNS = `
  a.id, a.user_id, a.account_type, a.account_size,
  a.current_balance, a.starting_balance, a.peak_balance, a.status,
  a.max_drawdown_pct, a.profit_target, a.phase_start_date, a.phase_end_date,
  a.account_uid, a.review_flagged, a.review_flag_reason,
  a.eod_peak_equity, a.eod_trailing_floor, a.challenge_model_slug
`

/**
 * Status transitions the domain permits. Anything absent is refused rather
 * than silently applied — previously every admin route set `status` with a raw
 * UPDATE and no transition was ever validated.
 */
const LEGAL_TRANSITIONS = {
  active: ['passed', 'failed', 'locked', 'expired', 'cancelled', 'closed'],
  passed: ['active', 'locked', 'cancelled', 'closed'],
  failed: ['active', 'locked', 'cancelled', 'closed'],
  locked: ['active', 'failed', 'cancelled', 'closed'],
  expired: ['active', 'cancelled', 'closed'],
  cancelled: ['active'],
  closed: []
}

class Account {
  constructor(client, row) {
    this.client = client
    this.row = row
  }

  get id() { return this.row.id }
  get userId() { return this.row.user_id }
  get status() { return String(this.row.status || '').toLowerCase() }
  get accountType() { return String(this.row.account_type || '').toLowerCase() }
  get currentBalance() { return parseFloat(this.row.current_balance) }
  get startingBalance() { return parseFloat(this.row.starting_balance) }
  get realizedProfit() {
    return parseFloat((this.currentBalance - this.startingBalance).toFixed(2))
  }

  /**
   * Apply a non-trade capital movement: ledger row + balance + drawdown anchor,
   * all in the caller's transaction.
   *
   * The anchor shift is the point. A payout used to debit the balance and leave
   * `eod_peak_equity` at the pre-payout high, so the trailing floor stayed
   * anchored to money that had left the account.
   *
   * @param {{amount:number, source:string, reason?:string, createdBy?:string,
   *          competitionId?:string|null, competitionEntryId?:string|null,
   *          metadata?:object, shiftDrawdownAnchors?:boolean}} input
   */
  async adjustBalance({
    amount,
    source,
    reason = '',
    createdBy = 'system',
    competitionId = null,
    competitionEntryId = null,
    metadata = {},
    shiftDrawdownAnchors = true
  }) {
    const result = await applyBalanceAdjustment(this.client, {
      accountId: this.id,
      amount,
      source,
      reason,
      createdBy,
      competitionId,
      competitionEntryId,
      metadata
    })

    if (shiftDrawdownAnchors) {
      await shiftAnchors(this.client, this.id, result.amount)
    }

    this.row.current_balance = result.balanceAfter
    this.row.peak_balance = result.peakBalance
    return result
  }

  /**
   * Reset the account to its starting balance and restart its drawdown frame.
   *
   * The balance delta goes through the ledger rather than a bare
   * `current_balance = starting_balance`, so a reset stays reconstructable like
   * any other capital movement. `peak_balance` is reset explicitly because
   * applyBalanceAdjustment only ever raises it (GREATEST), and the anchors are
   * rebased rather than shifted — a reset restarts the frame, it does not
   * translate it.
   */
  async resetToStarting({ reason = 'Account reset', createdBy = 'system', metadata = {} } = {}) {
    // Re-read rather than trusting the cached row. Callers routinely force-close
    // open trades first (routes/admin/shared/tradeOps.js), which moves
    // current_balance after this aggregate was loaded — computing the delta from
    // a stale snapshot would book the wrong ledger amount.
    const live = await this.client.query(
      `SELECT current_balance, starting_balance FROM accounts WHERE id = $1`,
      [this.id]
    )
    if (live.rows.length === 0) throw new NotFound('Account not found')
    this.row.current_balance = live.rows[0].current_balance
    this.row.starting_balance = live.rows[0].starting_balance

    const delta = parseFloat((this.startingBalance - this.currentBalance).toFixed(2))

    if (delta !== 0) {
      await this.adjustBalance({
        amount: delta,
        source: 'admin_reset',
        reason,
        createdBy,
        metadata,
        // Rebased below instead — a reset restarts the drawdown frame rather
        // than translating it, so shifting by the delta would be wrong.
        shiftDrawdownAnchors: false
      })
    }

    await this.client.query(
      `UPDATE accounts SET peak_balance = starting_balance, updated_at = NOW() WHERE id = $1`,
      [this.id]
    )
    await rebaseAnchors(this.client, this.id, this.startingBalance)

    this.row.current_balance = this.startingBalance
    this.row.peak_balance = this.startingBalance
    return { delta }
  }

  /**
   * Move the account to a new lifecycle status, refusing transitions the domain
   * does not allow.
   */
  async changeStatus(next, { reason = '', createdBy = 'system', extraColumns = {} } = {}) {
    const target = String(next || '').toLowerCase()
    const current = this.status

    if (!target) throw new DomainError('A target status is required')
    if (target === current) return { changed: false, status: current }

    const allowed = LEGAL_TRANSITIONS[current]
    if (!allowed) {
      throw new InvariantViolation(`Unknown account status "${current}"`)
    }
    if (!allowed.includes(target)) {
      throw new InvariantViolation(`Cannot move an account from ${current} to ${target}`)
    }

    const sets = ['status = $2', 'updated_at = NOW()']
    const values = [this.id, target]
    for (const [column, value] of Object.entries(extraColumns)) {
      values.push(value)
      sets.push(`${column} = $${values.length}`)
    }

    const result = await this.client.query(
      `UPDATE accounts SET ${sets.join(', ')} WHERE id = $1 RETURNING status`,
      values
    )
    if (result.rows.length === 0) throw new NotFound('Account not found')

    this.row.status = target
    return { changed: true, status: target, from: current, reason, createdBy }
  }

  /**
   * Throw unless this account may withdraw. Used by both the trader request
   * path and — the part that was missing — admin approval.
   */
  assertCanRequestPayout(context = {}) {
    const { blockers } = evaluatePayoutEligibility({ account: this.row, ...context })
    if (blockers.length > 0) {
      throw new InvariantViolation(blockers[0].message, 403)
    }
    return true
  }

  /** Throw unless this account may open new exposure. */
  assertCanOpenOrder() {
    if (this.status !== 'active') {
      throw new InvariantViolation(`Account status is ${this.row.status}.`, 403)
    }
    return true
  }
}

/**
 * Load an account under a row lock. Callers must already be in a transaction —
 * FOR UPDATE outside one locks nothing useful.
 */
async function loadForUpdate(client, accountId) {
  const result = await client.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM accounts a WHERE a.id = $1 FOR UPDATE`,
    [String(accountId)]
  )
  if (result.rows.length === 0) throw new NotFound('Account not found')
  return new Account(client, result.rows[0])
}

/** Wrap a row the caller already locked, to avoid a second SELECT ... FOR UPDATE. */
function fromLockedRow(client, row) {
  if (!row) throw new NotFound('Account not found')
  return new Account(client, row)
}

module.exports = { Account, loadForUpdate, fromLockedRow, LEGAL_TRANSITIONS }
