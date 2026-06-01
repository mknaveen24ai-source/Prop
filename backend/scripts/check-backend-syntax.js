const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const SKIP_DIRS = new Set(['node_modules', 'logs', 'uploads'])

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(fullPath, files)
    } else if (entry.name.endsWith('.js')) {
      files.push(fullPath)
    }
  }
  return files
}

function main() {
  const files = walk(ROOT)
  const failures = []

  for (const file of files) {
    const result = spawnSync(process.execPath, ['--check', file], {
      cwd: ROOT,
      encoding: 'utf8'
    })
    if (result.status !== 0) {
      failures.push({
        file: path.relative(ROOT, file),
        output: result.stderr || result.stdout || 'syntax check failed'
      })
    }
  }

  if (failures.length > 0) {
    console.error(`[syntax] ${failures.length} backend JS file(s) failed syntax check`)
    for (const failure of failures) {
      console.error(`\n${failure.file}\n${failure.output}`)
    }
    process.exit(1)
  }

  console.log(`[syntax] All backend JS files passed (${files.length})`)
}

main()
