import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

void test('compiled builds include the schema baseline manifest', () => {
  const manifestPath = path.join(__dirname, '..', 'migrations', '000_core_schema.manifest.json')

  assert.equal(existsSync(manifestPath), true, 'baseline manifest must ship beside the schema dump')

  const manifest = readFileSync(manifestPath, 'utf8')
  assert.match(manifest, /035_idempotency_hardening\.js/)
  assert.doesNotMatch(
    manifest,
    /044_deferred_sl_tp_trigger\.js/,
    'migrations newer than the dump must be executed, not stamped as baselined'
  )
})
