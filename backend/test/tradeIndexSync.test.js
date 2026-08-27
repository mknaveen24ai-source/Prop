const test = require('node:test')
const assert = require('node:assert/strict')

const tradeIndexSync = require('../services/tradeIndexSync')
const tradeEngine = require('../services/tradeEngine')
const tradeIndex = require('../utils/tradeIndex')

test('an open mutation refreshes the engine index and account aggregates', async () => {
  const original = {
    syncOpenedTrade: tradeEngine.syncOpenedTrade,
    applyRealizedPnl: tradeIndex.applyRealizedPnl,
    updateAccountBalance: tradeIndex.updateAccountBalance
  }
  const calls = []
  tradeEngine.syncOpenedTrade = async (trade) => { calls.push(['open', trade]) }
  tradeIndex.applyRealizedPnl = (accountId, pnl) => { calls.push(['realized', accountId, pnl]) }
  tradeIndex.updateAccountBalance = (accountId, balance) => { calls.push(['balance', accountId, balance]) }

  try {
    const trade = { id: 'trade-1', account_id: 'account-1' }
    await tradeIndexSync.applyMutation({
      type: 'open',
      payload: { trade, realizedPnl: 12.5, currentBalance: 10012.5 }
    })
    assert.deepEqual(calls, [
      ['open', trade],
      ['realized', 'account-1', 12.5],
      ['balance', 'account-1', 10012.5]
    ])
  } finally {
    Object.assign(tradeEngine, { syncOpenedTrade: original.syncOpenedTrade })
    Object.assign(tradeIndex, {
      applyRealizedPnl: original.applyRealizedPnl,
      updateAccountBalance: original.updateAccountBalance
    })
  }
})

test('a close mutation removes the indexed trade and refreshes the cached balance', async () => {
  const original = {
    syncClosedTrade: tradeEngine.syncClosedTrade,
    getAccountEntry: tradeIndex.getAccountEntry,
    updateAccountBalance: tradeIndex.updateAccountBalance
  }
  const calls = []
  tradeEngine.syncClosedTrade = (...args) => { calls.push(['closed', ...args]) }
  tradeIndex.getAccountEntry = () => ({ id: 'account-1' })
  tradeIndex.updateAccountBalance = (...args) => { calls.push(['balance', ...args]) }

  try {
    await tradeIndexSync.applyMutation({
      type: 'closed',
      payload: { tradeId: 'trade-1', accountId: 'account-1', realizedPnl: -7, currentBalance: 9993 }
    })
    assert.deepEqual(calls, [
      ['closed', 'trade-1', 'account-1', -7],
      ['balance', 'account-1', 9993]
    ])
  } finally {
    Object.assign(tradeEngine, { syncClosedTrade: original.syncClosedTrade })
    Object.assign(tradeIndex, {
      getAccountEntry: original.getAccountEntry,
      updateAccountBalance: original.updateAccountBalance
    })
  }
})
