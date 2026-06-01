const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const tradesSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'trades.js'), 'utf8')
const challengeSource = fs.readFileSync(path.join(__dirname, '..', 'challengeEngine.js'), 'utf8')
const adminSource = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin.js'), 'utf8')

function functionBody(name, nextName, sourceText = tradesSource) {
  const start = sourceText.indexOf(`async function ${name}`)
  assert.notEqual(start, -1, `${name} should exist`)
  const end = nextName ? sourceText.indexOf(`async function ${nextName}`, start + 1) : sourceText.length
  assert.notEqual(end, -1, `${nextName} should exist after ${name}`)
  return sourceText.slice(start, end)
}

function routeBody(method, pathLiteral, nextMarker) {
  const start = tradesSource.indexOf(`router.${method}('${pathLiteral}'`)
  assert.notEqual(start, -1, `${method.toUpperCase()} ${pathLiteral} should exist`)
  const end = nextMarker ? tradesSource.indexOf(nextMarker, start + 1) : tradesSource.length
  assert.notEqual(end, -1, `${nextMarker} should exist after ${method.toUpperCase()} ${pathLiteral}`)
  return tradesSource.slice(start, end)
}

test('autoCloseAndPass is fail-fast and emits copier events only after commit', () => {
  const source = functionBody('autoCloseAndPass', 'checkFloatingDrawdown')

  assert.match(source, /const copierEvents = \[\]/)
  assert.match(source, /throw err/)
  assert.match(source, /auto_pass_aborted/)
  assert.doesNotMatch(source, /Error closing trade \$\{trade\.id\} on profit target hit/)

  const commitIndex = source.indexOf("await client.query('COMMIT')")
  const emitIndex = source.indexOf('await emitCopierEventSafe(event)')
  assert.ok(commitIndex > -1, 'auto-pass should commit before side effects')
  assert.ok(emitIndex > commitIndex, 'copier events should emit only after commit')
})

test('autoCloseAndFail keeps Decimal PnL conversion before balance, violation, and socket use', () => {
  const source = functionBody('autoCloseAndFail', 'autoCloseAndPass')

  assert.match(source, /let totalPnlDec = new Decimal\(0\)/)
  assert.match(source, /const totalPnl = totalPnlDec\.toDecimalPlaces\(2\)\.toNumber\(\)/)
  assert.match(source, /total_closed_pnl: totalPnl/)
  assert.match(source, /pnl: totalPnl/)
  assert.doesNotMatch(source, /total_closed_pnl: totalPnlDec/)
  assert.doesNotMatch(source, /Error closing trade \$\{trade\.id\} on drawdown breach/)
  assert.match(source, /Failed to close trade \$\{trade\.id\} during drawdown breach/)
})

test('challengeEngine failAccount does not swallow close failures before failing account', () => {
  const source = functionBody('failAccount', 'passAccount', challengeSource)

  assert.match(source, /let totalPnlDec = new Decimal\(0\)/)
  assert.match(source, /throw new Error\(`Failed to close trade \$\{trade\.id\} while failing account`\)/)
  assert.doesNotMatch(source, /failAccount: error closing trade \$\{trade\.id\}/)
})

test('challengeEngine lifecycle closures create copier outbox events after commit', () => {
  const expireSource = functionBody('expireAccount', 'failAccount', challengeSource)
  const failSource = functionBody('failAccount', 'passAccount', challengeSource)
  const passSource = functionBody('passAccount', 'processAccount', challengeSource)

  for (const source of [expireSource, failSource, passSource]) {
    const commitIndex = source.indexOf("await client.query('COMMIT')")
    const emitIndex = source.indexOf('await emitCopierEventSafe(event)')
    assert.ok(commitIndex > -1, 'challenge lifecycle should commit before side effects')
    assert.ok(emitIndex > commitIndex, 'challenge copier events should emit after commit')
  }

  assert.match(expireSource, /eventType: 'CLOSE_POSITION'/)
  assert.match(expireSource, /eventType: 'CANCEL_PENDING'/)
  assert.match(expireSource, /Failed to close trade \$\{trade\.id\} while expiring account/)
  assert.match(expireSource, /throw tradeError/)
  assert.match(failSource, /eventType: 'CLOSE_POSITION'/)
  assert.match(failSource, /eventType: 'CANCEL_PENDING'/)
  assert.match(passSource, /eventType: 'CANCEL_PENDING'/)
})

test('admin force-close helpers queue copier events and routes emit them after commit', () => {
  const closeAllSource = functionBody('forceCloseOpenTradesForAccount', 'cancelPendingTradesForAccount', adminSource)
  const cancelSource = functionBody('cancelPendingTradesForAccount', 'forceCloseTradeById', adminSource)
  const closeOneSource = functionBody('forceCloseTradeById', 'getExposureData', adminSource)

  assert.match(closeAllSource, /eventType: 'CLOSE_POSITION'/)
  assert.match(closeAllSource, /queueAdminCopierEvent\(copierEventsTarget/)
  assert.match(cancelSource, /eventType: 'CANCEL_PENDING'/)
  assert.match(closeOneSource, /eventType: 'CLOSE_POSITION'/)

  assert.match(adminSource, /await emitCopierEventsAfterCommit\(copierEvents\)/)
  assert.match(adminSource, /admin_emergency_kill/)
  assert.match(adminSource, /admin_enforcement_force_close_open_trades/)
})

test('pending, modify, cancel, and batch action routes protect race/copy side effects', () => {
  const pendingSource = functionBody('checkPendingOrders', 'autoCloseAndFail')
  assert.match(pendingSource, /source: 'pending_trigger_rejected'/)
  assert.match(pendingSource, /source: 'pending_account_inactive_cancel'/)

  const cancelSource = routeBody('post', '/cancel', '// PATCH /api/trades/modify')
  assert.match(cancelSource, /WHERE id = \$1 AND status = 'pending'/)
  assert.match(cancelSource, /Pending order was already processed/)

  const pendingModifySource = routeBody('patch', '/modify-pending', "router.patch('/modify'")
  assert.match(pendingModifySource, /validatePendingOrderPrice\(trade\.order_type, nextPendingPrice, bid, ask\)/)
  assert.match(pendingModifySource, /WHERE id = \$\$\{idx\} AND status = 'pending' RETURNING \*/)
  assert.match(pendingModifySource, /eventType: 'MODIFY_PENDING'/)
  assert.match(pendingModifySource, /source: 'trade_modify_pending_manual'/)

  const modifySource = routeBody('patch', '/modify', '// PATCH /api/trades/note')
  assert.match(modifySource, /WHERE id = \$\$\{idx\} AND status = 'open'/)
  assert.match(modifySource, /Trade was already processed/)

  const batchSource = routeBody('post', '/batch-action', "router.get('/:tradeId/screenshot/:kind'")
  assert.match(batchSource, /const copierEvents = \[\]/)
  assert.match(batchSource, /eventType: 'CLOSE_POSITION'/)
  assert.match(batchSource, /eventType: 'MODIFY_POSITION'/)
  assert.match(batchSource, /await emitCopierEventSafe\(event\)/)
})
