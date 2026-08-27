// Single source of truth for the human-readable account_uid scheme, used both
// by the runtime account-creation paths and the one-time backfill migration
// (023_recode_account_uid.js) so the two can never drift apart.
//
// Scheme (steps come from challenge_model_slug; NULL/unrecognized defaults to
// '2-step' — the only value consistent with the legacy phase1->phase2->funded
// flow and admin-issued accounts, neither of which ever set a step model):
//   competition                -> C00001
//   1-step, phase1             -> 1S00001
//   2-step, phase1 / phase2    -> 2SP100001 / 2SP200001
//   3-step, phase1/2/3         -> 3SP100001 / 3SP200001 / 3SP300001
//   funded (from 1/2/3-step)   -> F1-00001 / F2-00001 / F3-00001

interface QueryResult<Row> {
  rows: Row[]
}

interface Queryable {
  query: <Row>(sql: string, values?: unknown[]) => Promise<QueryResult<Row>>
}

interface AccountIdSequenceRow {
  last_value: number
}

interface AccountIdInput {
  accountType: string | null | undefined
  challengeModelSlug: string | null | undefined
}

interface AccountIdCategory {
  category: string
  prefix: string
}

const ACCOUNT_UID_PAD = 5

function stepsForModelSlug(challengeModelSlug: string | null | undefined): 1 | 2 | 3 {
  if (challengeModelSlug === '1-step') return 1
  if (challengeModelSlug === '3-step') return 3
  return 2
}

function resolveAccountIdCategory({
  accountType,
  challengeModelSlug
}: AccountIdInput): AccountIdCategory {
  const type = String(accountType || '').toLowerCase()

  if (type === 'competition') {
    return { category: 'competition', prefix: 'C' }
  }

  const steps = stepsForModelSlug(challengeModelSlug)

  if (type === 'funded') {
    return { category: `funded_${steps}step`, prefix: `F${steps}-` }
  }

  if (steps === 1) {
    return { category: '1step', prefix: '1S' }
  }

  const phase = parseInt(type.replace('phase', ''), 10) || 1
  return { category: `${steps}step_phase${phase}`, prefix: `${steps}SP${phase}` }
}

// Atomic per-category counter: a single upsert, race-safe under concurrent
// account creation without any extra locking (same pattern as bbook_pnl's
// ON CONFLICT ... DO UPDATE upserts in progressionService.js).
async function nextAccountIdSequence(db: Queryable, category: string): Promise<number> {
  const result = await db.query<AccountIdSequenceRow>(
    `INSERT INTO account_id_sequences (category, last_value)
     VALUES ($1, 1)
     ON CONFLICT (category) DO UPDATE SET last_value = account_id_sequences.last_value + 1
     RETURNING last_value`,
    [category]
  )
  const row = result.rows[0]
  if (!row) throw new Error('Account ID sequence query returned no row')
  return row.last_value
}

async function generateAccountUid(db: Queryable, input: AccountIdInput): Promise<string> {
  const { accountType, challengeModelSlug } = input
  const { category, prefix } = resolveAccountIdCategory({ accountType, challengeModelSlug })
  const seq = await nextAccountIdSequence(db, category)
  return `${prefix}${String(seq).padStart(ACCOUNT_UID_PAD, '0')}`
}

export {
  ACCOUNT_UID_PAD,
  resolveAccountIdCategory,
  nextAccountIdSequence,
  generateAccountUid
}
