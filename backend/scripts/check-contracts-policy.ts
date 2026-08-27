import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const permittedFiles = new Set(['package.json', 'README.md'])

function declarationFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return declarationFiles(absolute)
    return [absolute]
  })
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) &&
    ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true
}

function checkDeclarationFile(file: string): string[] {
  const sourceText = fs.readFileSync(file, 'utf8')
  const source = ts.createSourceFile(file, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const failures: string[] = []

  const program = ts.createProgram([file], { noEmit: true, noResolve: true, skipLibCheck: true })
  const programSource = program.getSourceFile(file)
  const diagnostics = programSource ? program.getSyntacticDiagnostics(programSource) : []
  for (const diagnostic of diagnostics) {
    if (diagnostic.category !== ts.DiagnosticCategory.Error) continue
    failures.push(`${file}: syntax error ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`)
  }

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause && !statement.importClause.isTypeOnly) {
        failures.push(`${file}: imports must use import type`)
      }
      continue
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.isTypeOnly) failures.push(`${file}: re-exports must use export type`)
      continue
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      if (!hasExportModifier(statement)) failures.push(`${file}: declarations must be exported types`)
      continue
    }
    if (ts.isEmptyStatement(statement)) continue

    if (ts.isEnumDeclaration(statement)) {
      failures.push(`${file}: TypeScript enum and const enum are prohibited`)
      continue
    }
    if (ts.isVariableStatement(statement)) {
      failures.push(`${file}: runtime value declarations are prohibited`)
      continue
    }

    failures.push(`${file}: runtime-capable declaration ${ts.SyntaxKind[statement.kind]} is prohibited`)
  }

  return failures
}

export function checkContractsPolicy(contractsDirectory: string): string[] {
  const failures: string[] = []
  const packageFile = path.join(contractsDirectory, 'package.json')
  const packageJson: unknown = JSON.parse(fs.readFileSync(packageFile, 'utf8'))
  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    return [`${packageFile}: expected an object`]
  }

  const packageRecord = Object.fromEntries(Object.entries(packageJson))
  for (const runtimeKey of ['main', 'module', 'browser', 'bin']) {
    if (runtimeKey in packageRecord) failures.push(`${packageFile}: ${runtimeKey} is prohibited`)
  }
  if (packageRecord.types !== './index.d.ts') {
    failures.push(`${packageFile}: types must point to ./index.d.ts`)
  }
  const expectedExports = JSON.stringify({ '.': { types: './index.d.ts' } })
  if (JSON.stringify(packageRecord.exports) !== expectedExports) {
    failures.push(`${packageFile}: exports must expose only the declarations entrypoint`)
  }

  for (const file of declarationFiles(contractsDirectory)) {
    const relative = path.relative(contractsDirectory, file)
    if (relative.endsWith('.d.ts')) {
      failures.push(...checkDeclarationFile(file))
      continue
    }
    if (!relative.includes(path.sep) && permittedFiles.has(relative)) continue
    failures.push(`${file}: contracts may contain only .d.ts declarations, package.json, and README.md`)
  }

  return failures
}

function main(): void {
  const contractsDirectory = process.env.CONTRACTS_ROOT
    ? path.resolve(process.env.CONTRACTS_ROOT)
    : path.resolve(process.cwd(), '..', 'contracts')
  const failures = checkContractsPolicy(contractsDirectory)
  if (failures.length > 0) {
    for (const failure of failures) console.error(failure)
    process.exitCode = 1
    return
  }
  console.log('contracts policy OK: declarations only, type-only imports/exports, no enums or runtime values')
}

if (require.main === module) main()
