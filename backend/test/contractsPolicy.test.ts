import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkContractsPolicy } from '../scripts/check-contracts-policy'

void test('the shared contracts package is declarations-only', () => {
  const contractsRoot = path.resolve(process.env.BACKEND_SOURCE_ROOT ?? '.', '..', 'contracts')
  assert.deepEqual(checkContractsPolicy(contractsRoot), [])
})

void test('the contracts policy rejects enums and runtime exports', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'propfirm-contracts-policy-'))
  context.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    types: './index.d.ts',
    exports: { '.': { types: './index.d.ts' } }
  }))
  fs.writeFileSync(path.join(root, 'README.md'), 'fixture')
  fs.writeFileSync(path.join(root, 'index.d.ts'), 'export enum Bad { Value = "value" }\nexport const runtimeValue: string\n')

  const failures = checkContractsPolicy(root)
  assert.equal(failures.length, 2)
  assert.match(failures.join('\n'), /enum and const enum/)
  assert.match(failures.join('\n'), /runtime value declarations/)
})
