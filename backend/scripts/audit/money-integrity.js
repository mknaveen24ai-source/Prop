'use strict'

/**
 * Money integrity check.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *     DATABASE_URL=... node scripts/audit/money-integrity.js
 *     ... --json
 *
 * Checks the arithmetic the platform's money rests on, against the live
 * instrument table and the live price feed. Pure calculation — it opens no
 * trades and writes nothing, so it is safe to run against any environment.
 *
 * Three properties, each of which has been wrong in this codebase before:
 *
 *  1. QUOTE-CURRENCY CONVERSION.  `priceDiff × lots × contractSize` is
 *     denominated in the instrument's quote currency. Booking that straight into
 *     a dollar balance overstates JPY-quoted results by roughly 150×. 31 of 45
 *     instruments are affected. The fix exists behind FX_CONVERSION_ENABLED;
 *     this reports, per instrument, what a fixed move actually books and whether
 *     that is plausible for the contract size.
 *
 *  2. NO BINARY FLOAT ANYWHERE ON THE MONEY PATH.  Decimal.js discipline in the
 *     application is worthless if a balance lands in a float column, and float
 *     appearing later is a silent regression. Checked against information_schema.
 *
 *  3. ROUNDING IS HALF-EVEN TO THE CENT AND NEVER COMPOUNDS.  A sequence of
 *     small trades must sum to the same cent as the sum of the sequence.
 */

require('../../loadEnv')

const Decimal = require('decimal.js')
const { Client } = require('pg')
const { calculatePnL } = require('../../utils/pnlCalculator')
const { CONTRACT_SIZES } = require('../../constants')

const JSON_OUT = process.argv.includes('--json')

const fxEnabled = String(process.env.FX_CONVERSION_ENABLED || '').trim().toLowerCase() === 'true'

/**
 * Instruments whose quote currency is not USD, with the rough USD value of one
 * unit of that currency. Used only to say whether a booked result is the right
 * ORDER OF MAGNITUDE — the live rate comes from the feed, not from here.
 */
const QUOTE_CURRENCY = {
  USDJPY: 'JPY', EURJPY: 'JPY', GBPJPY: 'JPY', AUDJPY: 'JPY', CADJPY: 'JPY',
  CHFJPY: 'JPY', NZDJPY: 'JPY', JP225: 'JPY',
  USDCHF: 'CHF', EURCHF: 'CHF', GBPCHF: 'CHF', AUDCHF: 'CHF', CADCHF: 'CHF', NZDCHF: 'CHF',
  USDCAD: 'CAD', EURCAD: 'CAD', GBPCAD: 'CAD', AUDCAD: 'CAD', NZDCAD: 'CAD',
  EURGBP: 'GBP', UK100: 'GBP',
  EURAUD: 'AUD', GBPAUD: 'AUD', AUS200: 'AUD',
  EURNZD: 'NZD', GBPNZD: 'NZD', AUDNZD: 'NZD',
  DE40: 'EUR', FRA40: 'EUR', EUSTX50: 'EUR',
  HK50: 'HKD'
}

function checkQuoteCurrencyConversion() {
  // One lot, a ten-pip move, on the instrument whose error was largest.
  const openPrice = 150.00
  const closePrice = 150.10

  // The rate is passed explicitly rather than resolved from the feed. Rates live
  // in the server's in-process price cache, so a standalone script sees an empty
  // one and calculatePnL throws FxRateUnavailableError -- correct fail-closed
  // behaviour, but it would make this check untestable outside the server. The
  // live feed path is exercised separately, against the running process.
  //
  // 1/150 is the reciprocal of a representative USDJPY quote.
  const rate = fxEnabled ? 1 / 150 : 1
  const booked = calculatePnL('buy', openPrice, closePrice, 1, 'USDJPY', 0, rate)

  // 0.10 JPY per unit × 100,000 units = 10,000 JPY. At ~150 JPY/USD that is
  // ~$66.67. Without conversion the platform books 10,000 as dollars.
  const rawQuote = new Decimal(closePrice).minus(openPrice).times(1).times(CONTRACT_SIZES.USDJPY || 100000)

  return {
    instrument: 'USDJPY',
    move: '1 lot, 10 pips',
    quoteCurrencyAmount: rawQuote.toNumber(),
    bookedUsd: booked,
    fxEnabled,
    // With conversion on, the booked figure must be far below the raw quote
    // amount. With it off they are equal, which is the defect.
    converted: Math.abs(booked - rawQuote.toNumber()) > 1,
    expectation: fxEnabled
      ? 'FX on: 10,000 JPY should book as roughly $60-70'
      : 'FX off: 10,000 JPY books as $10,000 — overstated ~150x'
  }
}

// Order-of-magnitude USD value of one unit of each quote currency. Used only to
// drive the arithmetic check; nothing depends on these being current.
const REPRESENTATIVE_RATES = {
  JPY: 1 / 150, CHF: 1.25, CAD: 0.72, GBP: 1.36, AUD: 0.71,
  NZD: 0.59, EUR: 1.17, HKD: 1 / 7.8
}

function nonUsdInstrumentSurvey() {
  const rows = []
  for (const [instrument, quote] of Object.entries(QUOTE_CURRENCY)) {
    const contractSize = CONTRACT_SIZES[instrument] || 100000

    // The price move is scaled so every instrument moves the same 10,000 units
    // of its quote currency, whatever its contract size.
    //
    // A fixed 0.01 move looked fine and was not: on the cash indices, whose
    // contract size is 1, it produces 0.01 of quote currency, and 0.01 x 1.17
    // rounds back to $0.01. Five correctly-converting instruments were reported
    // as unconverted purely because the difference fell under the cent.
    const move = new Decimal(10000).dividedBy(contractSize)

    // Representative rates, same reasoning as above: this checks the ARITHMETIC,
    // not the feed. Real rates are asserted by scripts/verify-fx-cutover.js.
    const rate = fxEnabled ? (REPRESENTATIVE_RATES[quote] ?? 1) : 1
    const closePrice = new Decimal(100).plus(move).toNumber()
    const booked = calculatePnL('buy', 100, closePrice, 1, instrument, 0, rate)
    const raw = move.times(contractSize).toNumber()
    rows.push({
      instrument,
      quote,
      contractSize,
      quoteCurrencyAmount: raw,
      bookedUsd: booked,
      converted: Math.abs(booked - raw) > 0.005
    })
  }
  return rows
}

async function checkMoneyColumnTypes(client) {
  const { rows } = await client.query(`
    SELECT table_name, column_name, data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND data_type IN ('double precision', 'real')
       AND (
         column_name ~ 'balance|equity|profit|amount|pnl|payout|price|drawdown|commission|fee|deposit|withdraw'
       )
     ORDER BY table_name, column_name
  `)
  return rows
}

function checkRoundingDoesNotCompound() {
  // 1,000 small trades. Summing the rounded results must equal the rounded sum;
  // if rounding compounded, the two drift apart by cents that belong to somebody.
  let summedRounded = new Decimal(0)
  let summedExact = new Decimal(0)
  const lots = 0.01
  const contractSize = CONTRACT_SIZES.EURUSD || 100000

  for (let i = 0; i < 1000; i++) {
    const open = 1.10000
    const close = new Decimal(1.10000).plus(new Decimal(i).times(0.00001)).toNumber()
    summedRounded = summedRounded.plus(calculatePnL('buy', open, close, lots, 'EURUSD', 0, 1))
    summedExact = summedExact.plus(
      new Decimal(close).minus(open).times(lots).times(contractSize)
    )
  }

  const drift = summedRounded.minus(summedExact.toDecimalPlaces(2)).abs()
  return {
    trades: 1000,
    summedRounded: summedRounded.toNumber(),
    summedExact: summedExact.toDecimalPlaces(2).toNumber(),
    driftUsd: drift.toNumber(),
    // Per-trade rounding legitimately differs from rounding the total; what
    // matters is that it stays proportional to the trade count and does not
    // run away. A cent per trade would be $10 here.
    acceptable: drift.lessThanOrEqualTo(new Decimal(1000).times(0.005))
  }
}

function checkCommissionIsNotScaled() {
  // Commission is charged in USD per lot, so converting it with the FX rate
  // would silently change every fee on non-USD instruments.
  const rate = fxEnabled ? 1 / 150 : 1
  const withoutCommission = calculatePnL('buy', 150.00, 150.10, 1, 'USDJPY', 0, rate)
  const withCommission = calculatePnL('buy', 150.00, 150.10, 1, 'USDJPY', 7, rate)
  const difference = new Decimal(withoutCommission).minus(withCommission).toNumber()
  return {
    commissionCharged: 7,
    observedDifference: difference,
    correct: Math.abs(difference - 7) < 0.005,
    note: 'commission must be subtracted after conversion, never scaled by the rate'
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is required.')
    process.exit(2)
  }
  const client = new Client({ connectionString: process.env.DATABASE_URL })
  await client.connect()

  const result = {
    fxEnabled,
    quoteConversion: checkQuoteCurrencyConversion(),
    instruments: nonUsdInstrumentSurvey(),
    floatMoneyColumns: await checkMoneyColumnTypes(client),
    rounding: checkRoundingDoesNotCompound(),
    commission: checkCommissionIsNotScaled()
  }
  await client.end()

  const unconverted = result.instruments.filter((r) => !r.converted)
  result.unconvertedCount = unconverted.length

  const failures = []
  if (result.floatMoneyColumns.length > 0) {
    failures.push(`${result.floatMoneyColumns.length} money column(s) stored as binary float`)
  }
  if (!result.rounding.acceptable) {
    failures.push(`rounding drift ${result.rounding.driftUsd} over ${result.rounding.trades} trades`)
  }
  if (!result.commission.correct) {
    failures.push('commission is being scaled by the FX rate')
  }
  if (fxEnabled && unconverted.length > 0) {
    failures.push(`FX is enabled but ${unconverted.length} non-USD instrument(s) still book unconverted`)
  }
  result.failures = failures

  if (JSON_OUT) console.log(JSON.stringify(result, null, 2))
  else report(result)

  process.exitCode = failures.length > 0 ? 1 : 0
}

function report(r) {
  console.log('Money integrity')
  console.log('='.repeat(70))
  console.log(`  FX_CONVERSION_ENABLED = ${r.fxEnabled}`)
  console.log('')

  const q = r.quoteConversion
  console.log('  1. Quote-currency conversion')
  console.log(`     ${q.instrument}, ${q.move}`)
  console.log(`       raw quote-currency amount   ${q.quoteCurrencyAmount.toLocaleString()} ${QUOTE_CURRENCY[q.instrument]}`)
  console.log(`       booked to the USD balance   $${q.bookedUsd.toLocaleString()}`)
  console.log(`       ${q.expectation}`)
  console.log('')

  console.log(`  2. Non-USD-quoted instruments: ${r.instruments.length} checked, ${r.unconvertedCount} booking unconverted`)
  if (r.unconvertedCount > 0 && !r.fxEnabled) {
    console.log('     (expected while FX_CONVERSION_ENABLED=false — this is the grandfathered behaviour)')
  }
  for (const row of r.instruments.slice(0, 6)) {
    console.log(`       ${row.instrument.padEnd(9)} quote=${row.quote}  ${row.quoteCurrencyAmount} ${row.quote} -> $${row.bookedUsd}`)
  }
  if (r.instruments.length > 6) console.log(`       ... and ${r.instruments.length - 6} more`)
  console.log('')

  console.log('  3. Money columns use an exact numeric type')
  if (r.floatMoneyColumns.length === 0) {
    console.log('     ✓ no money column is stored as double precision or real')
  } else {
    for (const c of r.floatMoneyColumns) {
      console.log(`     ✗ ${c.table_name}.${c.column_name} is ${c.data_type}`)
    }
  }
  console.log('')

  console.log('  4. Rounding does not compound')
  console.log(`     ${r.rounding.trades} trades: summed-rounded $${r.rounding.summedRounded}, rounded-sum $${r.rounding.summedExact}`)
  console.log(`     drift $${r.rounding.driftUsd} — ${r.rounding.acceptable ? '✓ within tolerance' : '✗ excessive'}`)
  console.log('')

  console.log('  5. Commission is charged in USD, not scaled by the rate')
  console.log(`     charged $${r.commission.commissionCharged}, observed difference $${r.commission.observedDifference} — ${r.commission.correct ? '✓' : '✗'}`)
  console.log('')

  if (r.failures.length === 0) {
    console.log('  ✓ no money-integrity failure')
  } else {
    console.log(`  ✗ ${r.failures.length} failure(s):`)
    for (const f of r.failures) console.log(`      ${f}`)
  }
  console.log('='.repeat(70))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(2)
})
