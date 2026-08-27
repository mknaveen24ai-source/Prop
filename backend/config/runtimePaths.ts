import path from 'node:path'

const emittedDirectoryNames = new Set(['dist', '.test-dist'])

export function resolveRuntimeRoot(moduleDirectory: string): string {
  const moduleParent = path.resolve(moduleDirectory, '..')
  return emittedDirectoryNames.has(path.basename(moduleParent))
    ? path.dirname(moduleParent)
    : moduleParent
}

export const RUNTIME_ROOT = resolveRuntimeRoot(__dirname)
export const UPLOADS_ROOT = path.join(RUNTIME_ROOT, 'uploads')
export const KYC_UPLOADS_ROOT = path.join(UPLOADS_ROOT, 'kyc')
export const DISPUTE_EVIDENCE_ROOT = path.join(UPLOADS_ROOT, 'dispute-evidence')
export const TRADE_JOURNAL_ROOT = path.join(UPLOADS_ROOT, 'trade-journal')
export const LOGS_ROOT = path.join(RUNTIME_ROOT, 'logs')
export const ASSETS_ROOT = path.join(RUNTIME_ROOT, 'assets')
export const MT5_BRIDGE_ROOT = path.resolve(process.env.DWX_PATH ?? path.join(RUNTIME_ROOT, 'mt5-bridge'))
