const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const watcherSource = fs.readFileSync(path.join(__dirname, '..', 'trade-copier', 'watcher.js'), 'utf8')

function functionBody(name, nextName) {
  const start = watcherSource.indexOf(`function ${name}`)
  assert.notEqual(start, -1, `${name} should exist`)
  const end = nextName ? watcherSource.indexOf(`function ${nextName}`, start + 1) : watcherSource.length
  assert.notEqual(end, -1, `${nextName} should exist after ${name}`)
  return watcherSource.slice(start, end)
}

test('copier uses phase challenge reverse 1:1 and funded mirror 1:1 policy', () => {
  const policySource = functionBody('resolveMasterAccountCopyPolicy', 'resolveCopiedDirection')
  const buildJobSource = watcherSource.slice(
    watcherSource.indexOf('async function buildJobForMapping'),
    watcherSource.indexOf('async function createJobsFromPendingEvents')
  )
  const lotsSource = functionBody('computeRequestedLots', 'shouldUseIdentitySymbol')

  assert.match(policySource, /normalized === 'phase1' \|\| normalized === 'phase2'/)
  assert.match(policySource, /copyMode: 'reverse'/)
  assert.match(policySource, /policy: 'challenge_reverse_1_to_1'/)
  assert.match(policySource, /normalized === 'funded'/)
  assert.match(policySource, /copyMode: 'mirror'/)
  assert.match(policySource, /policy: 'funded_mirror_1_to_1'/)
  assert.match(policySource, /riskMode: 'master_lots_1_1'/)

  assert.match(buildJobSource, /const accountCopyPolicy = resolveMasterAccountCopyPolicy\(masterMeta\.account_type\)/)
  assert.match(buildJobSource, /const copyMode = accountCopyPolicy\.copyMode \|\| mapping\.copy_mode_override/)
  assert.match(buildJobSource, /riskMode: accountCopyPolicy\.riskMode \|\| mapping\.follower_risk_mode/)
  assert.match(buildJobSource, /copy_policy: accountCopyPolicy\.policy/)

  assert.match(lotsSource, /riskMode === 'master_lots_1_1'/)
  assert.match(lotsSource, /rawLots = masterLots/)
})

test('reverse pending orders keep the same trigger level with opposite order type', () => {
  const source = functionBody('normalizeOrderTypeForCopy', 'resolveMasterAccountCopyPolicy')

  assert.match(source, /normalized === 'buy_limit'\) return 'sell_stop'/)
  assert.match(source, /normalized === 'sell_limit'\) return 'buy_stop'/)
  assert.match(source, /normalized === 'buy_stop'\) return 'sell_limit'/)
  assert.match(source, /normalized === 'sell_stop'\) return 'buy_limit'/)
})
