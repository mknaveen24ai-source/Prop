import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import {
  ASSETS_ROOT,
  LOGS_ROOT,
  RUNTIME_ROOT,
  UPLOADS_ROOT,
  resolveRuntimeRoot
} from '../config/runtimePaths'

void test('runtime paths do not move below dist after compilation', () => {
  assert.equal(resolveRuntimeRoot('/app/dist/config'), '/app')
  assert.equal(resolveRuntimeRoot('/app/.test-dist/config'), '/app')
  assert.equal(resolveRuntimeRoot('/workspace/backend/config'), '/workspace/backend')
})

void test('uploads, logs, and assets share the stable application root', () => {
  assert.equal(UPLOADS_ROOT, path.join(RUNTIME_ROOT, 'uploads'))
  assert.equal(LOGS_ROOT, path.join(RUNTIME_ROOT, 'logs'))
  assert.equal(ASSETS_ROOT, path.join(RUNTIME_ROOT, 'assets'))
  assert.equal(path.basename(UPLOADS_ROOT), 'uploads')
  assert.equal(path.basename(LOGS_ROOT), 'logs')
  assert.equal(path.basename(ASSETS_ROOT), 'assets')
})
