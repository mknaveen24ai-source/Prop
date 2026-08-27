import assert from 'node:assert/strict'
import test from 'node:test'
import type { QueryResult, QueryResultRow } from 'pg'
import {
  calcTradePnl,
  forceCloseTradeByIdWithPrice
} from '../routes/admin/shared/tradeOps'

interface RecordedQuery {
  sql: string
  values: unknown[] | undefined
}

function queryResult<Row extends QueryResultRow>(
  rows: Row[],
  rowCount: number | null = rows.length
): QueryResult<Row> {
  return { rows, rowCount, command: '', oid: 0, fields: [] }
}

void test('admin PnL calculation preserves contract-size and direction behavior', () => {
  assert.equal(calcTradePnl('buy', '1.1000', '1.1010', '1', 'EURUSD'), 100)
  assert.equal(calcTradePnl('sell', '1.1010', '1.1000', '0.5', 'EURUSD'), 50)
})

void test('single-trade force close persists decimal strings and updates the account after the trade', async () => {
  const recorded: RecordedQuery[] = []
  let call = 0
  const client = {
    async query<Row extends QueryResultRow>(sql: string, values?: unknown[]): Promise<QueryResult<Row>> {
      recorded.push({ sql, values })
      call += 1
      if (call === 1) {
        return queryResult([{
          id: 'trade-1',
          account_id: 'account-1',
          user_id: 'user-1',
          instrument: 'EURUSD',
          direction: 'buy',
          open_price: '1.1000',
          lot_size: '1.00',
          commission: '7.00'
        }]) as unknown as QueryResult<Row>
      }
      return queryResult([], 1) as QueryResult<Row>
    }
  }

  const closed = await forceCloseTradeByIdWithPrice(
    client,
    'trade-1',
    'Admin Force Close',
    async () => ({ bid: 1.101, ask: 1.1012 })
  )
  assert.deepEqual(closed, {
    trade_id: 'trade-1',
    account_id: 'account-1',
    user_id: 'user-1',
    instrument: 'EURUSD',
    pnl: 93,
    close_price: 1.101
  })
  assert.deepEqual(recorded[1]?.values, ['1.101', '93', 'Admin Force Close', 'trade-1'])
  assert.deepEqual(recorded[2]?.values, ['93', 'account-1'])
  assert.match(recorded[1]?.sql || '', /UPDATE trades/u)
  assert.match(recorded[2]?.sql || '', /UPDATE accounts/u)
})

void test('single-trade force close stops before the account write when the trade update loses', async () => {
  let call = 0
  const client = {
    async query<Row extends QueryResultRow>(): Promise<QueryResult<Row>> {
      call += 1
      if (call === 1) {
        return queryResult([{
          id: 'trade-1',
          account_id: 'account-1',
          user_id: 'user-1',
          instrument: 'EURUSD',
          direction: 'buy',
          open_price: '1.1000',
          lot_size: '1.00',
          commission: '0'
        }]) as unknown as QueryResult<Row>
      }
      return queryResult([], 0) as QueryResult<Row>
    }
  }
  await assert.rejects(
    forceCloseTradeByIdWithPrice(client, 'trade-1', 'Admin Force Close', async () => ({ bid: 1.101, ask: 1.102 })),
    /Failed to force-close trade trade-1/u
  )
  assert.equal(call, 2)
})
