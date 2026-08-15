#!/usr/bin/env node
'use strict'
/**
 * FX cutover preflight (audit finding C-01)
 * ─────────────────────────────────────────────────────────────────────────────
 * Run this BEFORE setting FX_CONVERSION_ENABLED=true.
 *
 * While the flag is false, getUsdRateForInstrument() returns 1 for everything,
 * which reproduces the old (wrong) maths exactly. Flipping the flag switches
 * every valuation to real rates in one step. For a position OPENED under the
 * old maths that is a revaluation the trader never agreed to — a non-USD
 * position showing +$10,000 floating would drop to +$67 the instant the flag
 * goes on.
 *
 * The agreed remediation is to grandfather: fix forward, never revalue history.
 * The only window where "grandfathered" and "correct" can disagree is a
 * non-USD-quoted position that is still open at cutover. Since the Phase 1
 * containment has blocked opening those, that set drains to zero on its own.
 *
 * This script proves it has:
 *
 *   ✓ no open or pending positions on non-USD-quoted instruments
 *   ✓ every quote currency the catalogue needs has a live rate source
 *
 * Exit 0 = safe to flip. Exit 1 = not yet.
 *
 *   node scripts/verify-fx-cutover.js
 */

require('../loadEnv')

const pool = require('../db')
const { INSTRUMENT_DEFINITIONS, USD_QUOTED_INSTRUMENTS, isFxConversionEnabled } = require('../instruments')
const { getRateSnapshot } = require('../utils/fxRates')
const { getCurrentPrices } = require('../priceFeed')
const priceCache = require('../utils/priceCache')

function line(ok, message) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${message}`)
}

async function main() {
  console.log('\nFX cutover preflight\n' + '='.repeat(60))
  console.log(`FX_CONVERSION_ENABLED is currently: ${isFxConversionEnabled()}`)

  const nonUsdInstruments = INSTRUMENT_DEFINITIONS
    .map((definition) => definition.symbol)
    .filter((symbol) => !USD_QUOTED_INSTRUMENTS.includes(symbol))

  let failures = 0

  // ── 1. No legacy positions left open on a non-USD-quoted instrument ────────
  console.log('\n1. Legacy positions opened under the old maths')
  const openLegacy = await pool.query(
    `SELECT t.instrument, t.status, COUNT(*)::int AS count
       FROM trades t
      WHERE t.status IN ('open', 'pending')
        AND t.instrument = ANY($1::text[])
      GROUP BY t.instrument, t.status
      ORDER BY count DESC`,
    [nonUsdInstruments]
  )

  if (openLegacy.rows.length === 0) {
    line(true, 'no open or pending positions on non-USD-quoted instruments')
  } else {
    failures++
    const total = openLegacy.rows.reduce((sum, row) => sum + row.count, 0)
    line(false, `${total} position(s) would be revalued by the cutover:`)
    for (const row of openLegacy.rows) {
      console.log(`      ${row.instrument.padEnd(10)} ${row.status.padEnd(8)} ${row.count}`)
    }
    console.log('\n      Wait for these to close, or close them under the current')
    console.log('      maths first. Do not flip the flag while they are open.')
  }

  // ── 2. Every quote currency has a usable rate source ───────────────────────
  console.log('\n2. Rate sources')
  await priceCache.updatePrices(await getCurrentPrices().catch(() => null))

  const needed = new Set(INSTRUMENT_DEFINITIONS.map((definition) => definition.quoteCurrency))
  const snapshot = getRateSnapshot()

  for (const currency of [...needed].sort()) {
    const entry = snapshot[currency]
    if (entry?.available) {
      line(true, `${currency.padEnd(4)} rate ${entry.rate.toPrecision(8)}`)
    } else {
      failures++
      line(false, `${currency.padEnd(4)} ${entry?.reason || 'no rate source configured'}`)
    }
  }

  // ── Verdict ───────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60))
  if (failures === 0) {
    console.log('READY. Safe to set FX_CONVERSION_ENABLED=true (and')
    console.log('VITE_FX_CONVERSION_ENABLED=true for the frontend), then restart.\n')
  } else {
    console.log(`NOT READY — ${failures} check(s) failed. Do not flip the flag.\n`)
  }
  return failures === 0 ? 0 : 1
}

main()
  .then(async (code) => { await pool.end().catch(() => {}); process.exit(code) })
  .catch(async (error) => {
    console.error('\nPreflight could not run:', error.message)
    await pool.end().catch(() => {})
    process.exit(1)
  })
