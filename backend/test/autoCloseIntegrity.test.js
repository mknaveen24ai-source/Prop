const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const challengeSource = fs.readFileSync(path.join(__dirname, '..', 'challengeEngine.js'), 'utf8')
// The engine functions these assertions guard live in services/tradeEngine.js.
const engineSource = fs.readFileSync(path.join(__dirname, '..', 'services', 'tradeEngine.js'), 'utf8')

// The route-level assertions read routes/trades/, which replaced the former
// single routes/trades.js. Each route now names the module it lives in; before
// the split every lookup scanned one file and bounded itself with the NEXT
// route's declaration, which is why several of these needed a `nextMarker` at
// all. Where a route is last in its module, the module end is the boundary.
function tradesModule(name) {
  return fs.readFileSync(path.join(__dirname, '..', 'routes', 'trades', `${name}.js`), 'utf8')
}

function functionBody(name, nextName, sourceText) {
  const start = sourceText.indexOf(`async function ${name}`)
  assert.notEqual(start, -1, `${name} should exist`)
  const end = nextName ? sourceText.indexOf(`async function ${nextName}`, start + 1) : sourceText.length
  assert.notEqual(end, -1, `${nextName} should exist after ${name}`)
  return sourceText.slice(start, end)
}

function routeBody(moduleName, method, pathLiteral, nextMarker) {
  const source = tradesModule(moduleName)
  const start = source.indexOf(`router.${method}('${pathLiteral}'`)
  assert.notEqual(start, -1, `${method.toUpperCase()} ${pathLiteral} should be in routes/trades/${moduleName}.js`)
  const end = nextMarker ? source.indexOf(nextMarker, start + 1) : source.length
  assert.notEqual(end, -1, `${nextMarker} should exist after ${method.toUpperCase()} ${pathLiteral}`)
  return source.slice(start, end)
}

test('autoCloseAndPass is fail-fast on trade close errors', () => {
  const source = functionBody('autoCloseAndPass', 'checkFloatingDrawdown', engineSource)

  assert.match(source, /throw err/)
  assert.match(source, /auto_pass_aborted/)
  assert.doesNotMatch(source, /Error closing trade \$\{trade\.id\} on profit target hit/)
})

test('autoCloseAndFail keeps Decimal PnL conversion before balance, violation, and socket use', () => {
  const source = functionBody('autoCloseAndFail', 'autoCloseAndPass', engineSource)

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

test('pending, modify, cancel, and batch action routes protect race side effects', () => {
  const pendingSource = functionBody('checkPendingOrders', 'autoCloseAndFail', engineSource)
  assert.match(pendingSource, /FOR UPDATE SKIP LOCKED/)
  assert.match(pendingSource, /Account inactive/)

  // /cancel is last in close.js, so the module end bounds it.
  const cancelSource = routeBody('close', 'post', '/cancel')
  assert.match(cancelSource, /WHERE id = \$1 AND status = 'pending'/)
  assert.match(cancelSource, /Pending order was already processed/)

  const pendingModifySource = routeBody('modify', 'patch', '/modify-pending', "router.patch('/modify'")
  assert.match(pendingModifySource, /validatePendingOrderPrice\(trade\.order_type, nextPendingPrice, bid, ask\)/)
  assert.match(pendingModifySource, /WHERE id = \$\$\{idx\} AND status = 'pending' RETURNING \*/)

  // /modify is last in modify.js; /batch-action is the only route in batch.js.
  const modifySource = routeBody('modify', 'patch', '/modify')
  assert.match(modifySource, /WHERE id = \$\$\{idx\} AND status = 'open'/)
  assert.match(modifySource, /Trade was already processed/)

  const batchSource = routeBody('batch', 'post', '/batch-action')
  assert.match(batchSource, /FOR UPDATE SKIP LOCKED/)
  assert.match(batchSource, /Batch Close/)
})
