import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const backendRoot = process.cwd()
const repositoryRoot = path.resolve(backendRoot, '..')
const allowlistPath = path.join(repositoryRoot, '.typescript-migration-js-allowlist')
const authoredExtensions = ['*.js', '*.jsx', '*.mjs', '*.cjs']

function sortedUnique(lines: string[]): string[] {
  return [...new Set(lines.filter(Boolean))].sort()
}

function readActualFiles(): string[] {
  const output = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      ...authoredExtensions
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  return sortedUnique(output.split('\0')).filter((file) => existsSync(path.join(repositoryRoot, file)))
}

function readAllowlist(): string[] {
  return sortedUnique(
    readFileSync(allowlistPath, 'utf8')
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith('#'))
  )
}

const actualFiles = readActualFiles()
const allowedFiles = readAllowlist()
const actualSet = new Set(actualFiles)
const allowedSet = new Set(allowedFiles)
const additions = actualFiles.filter((file) => !allowedSet.has(file))
const staleEntries = allowedFiles.filter((file) => !actualSet.has(file))

if (additions.length > 0 || staleEntries.length > 0) {
  if (additions.length > 0) {
    console.error('New authored JavaScript is forbidden:')
    for (const file of additions) console.error(`  + ${file}`)
  }
  if (staleEntries.length > 0) {
    console.error('Remove migrated/deleted files from the JavaScript allowlist:')
    for (const file of staleEntries) console.error(`  - ${file}`)
  }
  process.exitCode = 1
} else {
  console.log(`authored JavaScript allowlist OK (${actualFiles.length} files)`)
}
