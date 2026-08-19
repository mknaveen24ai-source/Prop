#!/usr/bin/env node
'use strict'

/**
 * Certificate system verification against a REAL database.
 *
 * `npm test` mocks the pg pool, so no SQL in this feature is exercised there —
 * which is exactly how `payouts.updated_at` stayed missing while four code
 * paths wrote to it. These suites run the real thing:
 *
 *   cert-integration  service layer: issue, idempotency, rollback, signature
 *                     round-trip through pg types, template resolution/pinning
 *   cert-http         routes: public verification, ownership, render formats
 *   cert-triggers     the promotion and payout hooks end to end
 *
 * Usage:
 *   DATABASE_URL=postgres://... npm run certificates:verify
 *
 * Point it at a SCRATCH database — it writes users, accounts and payouts.
 */

const { spawnSync } = require('child_process')
const path = require('path')

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required. Point it at a scratch database, not production.')
  process.exit(1)
}

const suites = ['cert-integration', 'cert-http', 'cert-triggers']
let failed = 0

for (const suite of suites) {
  console.log(`\n─── ${suite} ${'─'.repeat(Math.max(0, 60 - suite.length))}`)
  const result = spawnSync(process.execPath, [path.join(__dirname, `${suite}.js`)], {
    stdio: 'inherit',
    env: process.env
  })
  if (result.status !== 0) failed += 1
}

console.log(failed === 0
  ? `\nAll ${suites.length} certificate suites passed.`
  : `\n${failed} of ${suites.length} certificate suites FAILED.`)
process.exit(failed === 0 ? 0 : 1)
