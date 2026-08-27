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

// FIX (M-03/M-04): both of these previously asserted on the presence of a
// per-trade try/catch inside the close loop — `throw err` in autoCloseAndPass,
// and a "Failed to close trade ... during drawdown breach" log in
// autoCloseAndFail.
//
// Those catches have been removed, because inside a Postgres transaction they
// could not do what they appeared to: any statement error aborts the whole
// transaction, so a caught-and-logged error still fails at COMMIT. The catch
// only deferred the failure while making the code read as resilient — and in
// autoCloseAndFail it was actively harmful, since totalPnlDec is accumulated
// before the UPDATE, so a swallowed error left the running total crediting a
// trade that was never closed.
//
// The invariant worth guarding is therefore the opposite of a specific catch:
// the close loop must contain NO catch that lets the pass continue. Errors
// propagate to the single outer handler, roll back cleanly, and retry next tick.

function closeLoopBody(source) {
  const start = source.indexOf('for (const trade of openTrades.rows)')
  assert.ok(start !== -1, 'close loop not found')
  const body = source.slice(start, source.indexOf('const totalPnl =', start))
  // Strip comments: these loops are heavily annotated with *why* the catch was
  // removed, and a bare /catch/ match would hit the explanation rather than any
  // real handler.
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

// Matches the syntax, not the word.
const CATCH_CLAUSE = /\}\s*catch\s*\(/

test('autoCloseAndPass does not swallow trade close errors', () => {
  const source = functionBody('autoCloseAndPass', 'checkFloatingDrawdown', engineSource)

  assert.doesNotMatch(closeLoopBody(source), CATCH_CLAUSE, 'the close loop must not catch per-trade errors')
  assert.match(source, /auto_pass_aborted/, 'the outer handler still records an aborted pass')
})

test('autoCloseAndFail keeps Decimal PnL conversion before balance, violation, and socket use', () => {
  const source = functionBody('autoCloseAndFail', 'autoCloseAndPass', engineSource)

  // CommonJS compilation rewrites the default Decimal import to
  // `decimal_js_1.default`; accept both authored and emitted spellings while
  // keeping the accumulator/order invariant intact.
  assert.match(source, /let totalPnlDec = new (?:Decimal|decimal_js_1\.default)\(0\)/)
  assert.match(source, /const totalPnl = totalPnlDec\.toDecimalPlaces\(2\)\.toNumber\(\)/)
  assert.match(source, /total_closed_pnl: totalPnl/)
  assert.match(source, /pnl: totalPnl/)
  assert.doesNotMatch(source, /total_closed_pnl: totalPnlDec/)
  assert.doesNotMatch(closeLoopBody(source), CATCH_CLAUSE, 'the close loop must not catch per-trade errors')
})

test('both auto-close paths settle a priceless trade identically', () => {
  // FIX (M-04): autoCloseAndFail closed at open_price with zero PnL and carried
  // on, while autoCloseAndPass threw and aborted the whole promotion. A feed
  // outage therefore failed accounts but could never pass them.
  //
  // This used to assert that the string `close_price = open_price` appeared in
  // both function bodies — i.e. that two independent copies of the rule happened
  // to agree. They now share ONE decision (settlementFor), so the assertion is
  // that neither has its own: a single implementation cannot drift from itself,
  // which is a stronger guarantee than matching two copies of it.
  const failSource = functionBody('autoCloseAndFail', 'autoCloseAndPass', engineSource)
  const passSource = functionBody('autoCloseAndPass', 'checkFloatingDrawdown', engineSource)

  for (const [name, source] of [['autoCloseAndFail', failSource], ['autoCloseAndPass', passSource]]) {
    assert.match(
      source, /settlementFor\(trade, priceMap\[trade\.instrument\]\)/,
      `${name} must settle through the shared settlementFor, not its own copy of the rule`
    )
    assert.doesNotMatch(source, /throw new Error\(`Missing live price/, `${name} must not abort on a missing price`)
    assert.doesNotMatch(
      source, /const close_price = trade\.direction === 'buy'/,
      `${name} must not reintroduce its own close-price derivation`
    )
  }
})

test('settlementFor closes a priceless trade flat, at the open price, for zero PnL', () => {
  // The behaviour the assertions above delegate to. Worth testing directly now
  // that it is one function: this is what makes a feed outage settle a trade the
  // same way whether the account is failing or passing.
  const { settlementFor } = require('../services/tradeEngine')

  const trade = {
    direction: 'buy',
    open_price: '1.10000',
    lot_size: '1',
    instrument: 'EURUSD',
    commission: '7'
  }

  const priceless = settlementFor(trade, null)
  assert.equal(priceless.priceless, true)
  assert.equal(priceless.closePrice, 1.1, 'a priceless trade closes at its open price')
  assert.equal(priceless.pnl, 0, 'flat means zero PnL — not even the commission is charged')

  // And the ordinary case still prices off the correct side of the book.
  const priced = settlementFor(trade, { bid: 1.10500, ask: 1.10520 })
  assert.equal(priced.priceless, false)
  assert.equal(priced.closePrice, 1.105, 'a BUY closes at the bid')
  assert.ok(priced.pnl > 0, 'a profitable buy should settle positive')
})

test('challengeEngine failAccount does not swallow close failures before failing account', () => {
  const source = functionBody('failAccount', 'passAccount', challengeSource)

  // CommonJS compilation rewrites the default Decimal import to
  // `decimal_js_1.default`; accept both spellings without weakening the
  // accumulator invariant.
  assert.match(source, /let totalPnlDec = new (?:Decimal|decimal_js_1\.default)\(0\)/)
  assert.match(source, /throw new Error\(`Failed to close trade \$\{trade\.id\} while failing account`\)/)
  assert.doesNotMatch(source, /failAccount: error closing trade \$\{trade\.id\}/)
})

test('pending, modify, cancel, and batch action routes protect race side effects', () => {
  const pendingSource = functionBody('checkPendingOrders', 'autoCloseAndFail', engineSource)
  assert.match(pendingSource, /FOR UPDATE SKIP LOCKED/)
  assert.match(pendingSource, /Account inactive/)

  // The converted close route registers a named handler; inspect the handler
  // body rather than the short router registration at the module end.
  const cancelSource = functionBody('cancelTradeHandler', null, tradesModule('close'))
  assert.match(cancelSource, /WHERE id = \$1 AND status = 'pending'/)
  assert.match(cancelSource, /Pending order was already processed/)

  const modifyModuleSource = tradesModule('modify')
  const pendingModifySource = functionBody('modifyPendingHandler', 'modifyTradeHandler', modifyModuleSource)
  assert.match(pendingModifySource, /validatePendingOrderPrice\(trade\.order_type, nextPendingPrice, bid, ask\)/)
  assert.match(pendingModifySource, /WHERE id = \$\$\{parameterIndex\} AND status = 'pending' RETURNING \*/)

  // /modify is last in modify.js. The converted batch route now registers a
  // named handler, so inspect that function rather than the short router call.
  const modifySource = functionBody('modifyTradeHandler', null, modifyModuleSource)
  assert.match(modifySource, /WHERE id = \$\$\{parameterIndex\} AND status = 'open'/)
  assert.match(modifySource, /Trade was already processed/)

  const batchSource = functionBody('batchActionHandler', null, tradesModule('batch'))
  assert.match(batchSource, /FOR UPDATE SKIP LOCKED/)
  assert.match(batchSource, /Batch Close/)
})
