import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync
} from 'node:fs'
import path from 'node:path'

const backendRoot = path.resolve(__dirname, '..')
const allowedOutputs = new Set(['dist', '.test-dist'])

function resolveOutput(rawOutput: string | undefined): string {
  const outputName = rawOutput ?? 'dist'
  if (!allowedOutputs.has(outputName)) {
    throw new Error(`Refusing unsupported build output: ${outputName}`)
  }
  return path.join(backendRoot, outputName)
}

function clean(outputRoot: string): void {
  rmSync(outputRoot, { recursive: true, force: true })
}

function linkRuntimeDirectory(outputRoot: string, name: string): void {
  const linkPath = path.join(outputRoot, name)
  if (existsSync(linkPath)) return
  const targetPath = path.join(backendRoot, name)
  const relativeTarget = path.relative(path.dirname(linkPath), targetPath)
  symlinkSync(relativeTarget, linkPath, 'dir')
}

function copyBuildAssets(outputRoot: string): void {
  const sourceMigrations = path.join(backendRoot, 'migrations')
  const outputMigrations = path.join(outputRoot, 'migrations')
  mkdirSync(outputMigrations, { recursive: true })

  for (const entry of readdirSync(sourceMigrations, { withFileTypes: true })) {
    const isBuildAsset = entry.name.endsWith('.sql') || entry.name === '000_core_schema.manifest.json'
    if (!entry.isFile() || !isBuildAsset) continue
    copyFileSync(
      path.join(sourceMigrations, entry.name),
      path.join(outputMigrations, entry.name)
    )
  }

  for (const directory of ['assets', 'logs', 'uploads']) {
    linkRuntimeDirectory(outputRoot, directory)
  }

  const environmentFile = path.join(backendRoot, '.env')
  const outputEnvironmentFile = path.join(outputRoot, '.env')
  if (existsSync(environmentFile) && !existsSync(outputEnvironmentFile)) {
    symlinkSync(path.relative(outputRoot, environmentFile), outputEnvironmentFile, 'file')
  }
}

const command = process.argv[2]
const outputRoot = resolveOutput(process.argv[3])

if (command === 'clean') {
  clean(outputRoot)
} else if (command === 'copy') {
  copyBuildAssets(outputRoot)
} else {
  throw new Error('Usage: tsx scripts/build-support.ts <clean|copy> <dist|.test-dist>')
}
