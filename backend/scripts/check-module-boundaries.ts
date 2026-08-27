import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

interface BoundaryBaseline {
  version: 1
  cycles: string[]
  lazyRequires: string[]
}

interface ModuleAnalysis {
  edges: Set<string>
  lazyRequires: Set<string>
}

const backendRoot = process.cwd()
const repositoryRoot = path.resolve(backendRoot, '..')
const baselinePath = path.join(repositoryRoot, '.typescript-migration-module-boundaries.json')
const sourceRoots = new Set(['config', 'domain', 'routes', 'services', 'types', 'utils', 'validation', 'workers'])
const sourceExtensions = new Set(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx'])

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort()
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isBoundaryBaseline(value: unknown): value is BoundaryBaseline {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record.version === 1
    && isStringArray(record.cycles)
    && isStringArray(record.lazyRequires)
}

function readBaseline(): BoundaryBaseline {
  const parsed: unknown = JSON.parse(readFileSync(baselinePath, 'utf8'))
  if (!isBoundaryBaseline(parsed)) {
    throw new Error(`Invalid module-boundary baseline: ${baselinePath}`)
  }
  return parsed
}

function trackedSourceFiles(): string[] {
  const output = execFileSync(
    'git',
    [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--',
      'backend/*.js',
      'backend/*.ts',
      'backend/config',
      'backend/domain',
      'backend/routes',
      'backend/services',
      'backend/types',
      'backend/utils',
      'backend/validation',
      'backend/workers'
    ],
    { cwd: repositoryRoot, encoding: 'utf8' }
  )
  return sortedUnique(output.split('\0'))
    .filter(Boolean)
    .filter((relativePath) => {
      const withoutBackend = relativePath.replace(/^backend\//u, '')
      const firstSegment = withoutBackend.split('/')[0] ?? ''
      const isRootFile = !withoutBackend.includes('/')
      return (isRootFile || sourceRoots.has(firstSegment))
        && sourceExtensions.has(path.extname(relativePath))
        && existsSync(path.join(repositoryRoot, relativePath))
    })
    .map((relativePath) => path.join(repositoryRoot, relativePath))
}

function moduleId(filePath: string): string {
  return path.relative(backendRoot, filePath)
    .replace(/\\/gu, '/')
    .replace(/\.(?:[cm]?[jt]sx?)$/u, '')
    .replace(/\/index$/u, '')
}

function scriptKind(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath)
  if (extension === '.ts') return ts.ScriptKind.TS
  if (extension === '.tsx') return ts.ScriptKind.TSX
  if (extension === '.jsx') return ts.ScriptKind.JSX
  return ts.ScriptKind.JS
}

function resolutionCandidates(sourcePath: string, specifier: string): string[] {
  const rawBase = path.resolve(path.dirname(sourcePath), specifier)
  const bases = specifier.endsWith('.js')
    ? [rawBase, rawBase.slice(0, -3)]
    : [rawBase]
  const candidates: string[] = []
  for (const base of bases) {
    candidates.push(base)
    for (const extension of sourceExtensions) candidates.push(`${base}${extension}`)
    for (const extension of sourceExtensions) candidates.push(path.join(base, `index${extension}`))
  }
  return candidates
}

function resolveRelativeModule(
  sourcePath: string,
  specifier: string,
  files: Set<string>
): string | null {
  if (!specifier.startsWith('.')) return null
  const resolved = resolutionCandidates(sourcePath, specifier).find((candidate) => files.has(candidate))
  return resolved ? moduleId(resolved) : null
}

function stringSpecifier(node: ts.Expression | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : null
}

function isFunctionBoundary(node: ts.Node): boolean {
  return ts.isFunctionDeclaration(node)
    || ts.isFunctionExpression(node)
    || ts.isArrowFunction(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)
}

function isNestedInFunction(node: ts.Node): boolean {
  let current = node.parent
  while (current && !ts.isSourceFile(current)) {
    if (isFunctionBoundary(current)) return true
    current = current.parent
  }
  return false
}

function analyzeModule(sourcePath: string, files: Set<string>): ModuleAnalysis {
  const id = moduleId(sourcePath)
  const source = ts.createSourceFile(
    sourcePath,
    readFileSync(sourcePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    scriptKind(sourcePath)
  )
  const edges = new Set<string>()
  const lazyRequires = new Set<string>()

  function addEdge(specifier: string): void {
    const target = resolveRelativeModule(sourcePath, specifier, files)
    if (target) edges.add(target)
  }

  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      addEdge(stringSpecifier(node.moduleSpecifier) ?? '')
    } else if (ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)) {
      const specifier = stringSpecifier(node.moduleReference.expression)
      if (specifier) addEdge(specifier)
    } else if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === 'require') {
      const specifier = stringSpecifier(node.arguments[0])
      if (specifier) addEdge(specifier)
      if (isNestedInFunction(node)) {
        lazyRequires.add(`${id} -> ${specifier ?? '<dynamic>'}`)
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return { edges, lazyRequires }
}

function stronglyConnectedCycles(graph: Map<string, Set<string>>): string[] {
  let index = 0
  const indices = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[] = []

  function connect(node: string): void {
    indices.set(node, index)
    lowLinks.set(node, index)
    index += 1
    stack.push(node)
    onStack.add(node)

    for (const target of graph.get(node) ?? []) {
      if (!graph.has(target)) continue
      if (!indices.has(target)) {
        connect(target)
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, lowLinks.get(target) ?? 0))
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node) ?? 0, indices.get(target) ?? 0))
      }
    }

    if (lowLinks.get(node) !== indices.get(node)) return
    const component: string[] = []
    let member: string | undefined
    do {
      member = stack.pop()
      if (member === undefined) break
      onStack.delete(member)
      component.push(member)
    } while (member !== node)

    const selfCycle = component.length === 1
      && (graph.get(component[0] ?? '')?.has(component[0] ?? '') ?? false)
    if (component.length > 1 || selfCycle) cycles.push(component.sort().join(' | '))
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) connect(node)
  }
  return cycles.sort()
}

function differences(actual: string[], expected: string[]): { added: string[]; stale: string[] } {
  const actualSet = new Set(actual)
  const expectedSet = new Set(expected)
  return {
    added: actual.filter((item) => !expectedSet.has(item)),
    stale: expected.filter((item) => !actualSet.has(item))
  }
}

function reportDifference(label: string, added: string[], stale: string[]): void {
  if (added.length > 0) {
    console.error(`New ${label} require review:`)
    for (const item of added) console.error(`  + ${item}`)
  }
  if (stale.length > 0) {
    console.error(`Remove resolved ${label} from the baseline:`)
    for (const item of stale) console.error(`  - ${item}`)
  }
}

const sourceFiles = trackedSourceFiles()
const fileSet = new Set(sourceFiles)
const graph = new Map<string, Set<string>>()
const lazyRequires = new Set<string>()
for (const sourcePath of sourceFiles) {
  const analysis = analyzeModule(sourcePath, fileSet)
  graph.set(moduleId(sourcePath), analysis.edges)
  for (const boundary of analysis.lazyRequires) lazyRequires.add(boundary)
}

const actualCycles = stronglyConnectedCycles(graph)
const actualLazyRequires = sortedUnique(lazyRequires)
const baseline = readBaseline()
const cycleDiff = differences(actualCycles, baseline.cycles)
const lazyDiff = differences(actualLazyRequires, baseline.lazyRequires)

reportDifference('dependency cycles', cycleDiff.added, cycleDiff.stale)
reportDifference('lazy require boundaries', lazyDiff.added, lazyDiff.stale)

if (cycleDiff.added.length > 0 || cycleDiff.stale.length > 0
  || lazyDiff.added.length > 0 || lazyDiff.stale.length > 0) {
  process.exitCode = 1
} else {
  console.log(
    `module boundaries OK (${sourceFiles.length} modules, ${actualCycles.length} cycles, `
    + `${actualLazyRequires.length} lazy requires)`
  )
}
