import assert from 'node:assert/strict'
import test from 'node:test'
import { BoundaryValidationError } from '../validation/unknown'
import { applyMutation } from '../services/tradeIndexSync'

void test('Redis trade-index mutations remain unknown until their discriminated payload validates', async () => {
  await assert.rejects(
    applyMutation({ type: 'open', payload: { trade: { id: 'missing-account-id' } } }),
    BoundaryValidationError
  )
  await assert.rejects(
    applyMutation({
      type: 'closed',
      payload: { tradeId: 'trade-1', accountId: 'account-1', realizedPnl: { unsafe: true } }
    }),
    BoundaryValidationError
  )
})
