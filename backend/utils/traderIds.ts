// Single source of truth for the human-readable trader_uid scheme, used both
// by the runtime user-creation paths and the one-time backfill migration
// (024_recode_trader_uid.js) so the two can never drift apart.
//
// Unlike account_uid (which is numbered per category), every trader gets the
// same prefix off one global sequence: TRADER-00001, TRADER-00002, ...

interface QueryResult<Row> {
  rows: Row[]
}

interface Queryable {
  query: <Row>(sql: string) => Promise<QueryResult<Row>>
}

interface TraderSequenceRow {
  last_value: number
}

const TRADER_UID_PREFIX = 'TRADER-'
const TRADER_UID_PAD = 5

// Atomic global counter: a single upsert against a one-row table, race-safe
// under concurrent signups without any extra locking (same pattern as
// account_id_sequences in utils/accountIds.js).
async function nextTraderSequence(db: Queryable): Promise<number> {
  const result = await db.query<TraderSequenceRow>(
    `INSERT INTO trader_id_sequences (id, last_value)
     VALUES (1, 1)
     ON CONFLICT (id) DO UPDATE SET last_value = trader_id_sequences.last_value + 1
     RETURNING last_value`
  )
  const row = result.rows[0]
  if (!row) throw new Error('Trader ID sequence query returned no row')
  return row.last_value
}

async function generateTraderUid(db: Queryable): Promise<string> {
  const seq = await nextTraderSequence(db)
  return `${TRADER_UID_PREFIX}${String(seq).padStart(TRADER_UID_PAD, '0')}`
}

export {
  TRADER_UID_PREFIX,
  TRADER_UID_PAD,
  nextTraderSequence,
  generateTraderUid
}
