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

const ACCOUNT_UID_PAD = 5

function stepsForModelSlug(challengeModelSlug) {
  if (challengeModelSlug === '1-step') return 1
  if (challengeModelSlug === '3-step') return 3
  return 2
}

function resolveAccountIdCategory({ accountType, challengeModelSlug }) {
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
async function nextAccountIdSequence(db, category) {
  const result = await db.query(
    `INSERT INTO account_id_sequences (category, last_value)
     VALUES ($1, 1)
     ON CONFLICT (category) DO UPDATE SET last_value = account_id_sequences.last_value + 1
     RETURNING last_value`,
    [category]
  )
  return result.rows[0].last_value
}

async function generateAccountUid(db, { accountType, challengeModelSlug }) {
  const { category, prefix } = resolveAccountIdCategory({ accountType, challengeModelSlug })
  const seq = await nextAccountIdSequence(db, category)
  return `${prefix}${String(seq).padStart(ACCOUNT_UID_PAD, '0')}`
}

module.exports = {
  ACCOUNT_UID_PAD,
  resolveAccountIdCategory,
  nextAccountIdSequence,
  generateAccountUid
}
