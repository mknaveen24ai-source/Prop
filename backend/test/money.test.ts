import assert from 'node:assert/strict'
import test from 'node:test'
import Decimal from 'decimal.js'
import {
  DecimalStringError,
  parseDecimalString,
  serializeDecimal
} from '../utils/money'

void test('decimal boundary accepts very large and very small plain decimal strings', () => {
  assert.equal(serializeDecimal(parseDecimalString('999999999999999999999999999999.999999999999999999')), '999999999999999999999999999999.999999999999999999')
  assert.equal(serializeDecimal(parseDecimalString('0.000000000000000001')), '0.000000000000000001')
})

void test('decimal boundary preserves negative values and canonicalizes zero', () => {
  assert.equal(serializeDecimal(parseDecimalString('-42.125')), '-42.125')
  assert.equal(serializeDecimal(parseDecimalString('-0.000')), '0')
  assert.equal(serializeDecimal(parseDecimalString('0')), '0')
})

void test('decimal boundary rejects malformed, exponent, numeric, and excessive-precision inputs', () => {
  for (const invalid of ['', ' 1', '1 ', '+1', '.1', '1.', '01', '1e3', 'NaN', 'Infinity', 12.5, null]) {
    assert.throws(() => parseDecimalString(invalid), DecimalStringError)
  }
  assert.throws(() => parseDecimalString('1.1234567890123456789'), /fractional digits/)
})

void test('decimal boundary enforces sign and integer limits without numeric coercion', () => {
  assert.throws(() => parseDecimalString('-0.01', { allowNegative: false }), /must not be negative/)
  assert.throws(() => parseDecimalString('1234', { maxIntegerDigits: 3 }), /integer digits/)
  assert.throws(() => parseDecimalString({ toString: () => '12.50' }), DecimalStringError)
})

void test('serialization does not use JavaScript number coercion at rounding boundaries', () => {
  const value = parseDecimalString('1.005')
  assert.equal(value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2), '1.01')
  assert.equal(serializeDecimal(value), '1.005')
})
