'use strict'
/**
 * uploadPaths.js — the one place the uploads directory is located.
 *
 * Before this module, eleven call sites each re-derived the uploads root by
 * counting directory hops from their own __dirname. Files directly under
 * backend/ need `'..', 'uploads'`; files in routes/admin/ need one more hop.
 * Two of them (routes/admin/kycDocuments.js and routes/admin/kycReview.js)
 * counted one short and resolved to backend/routes/uploads, which does not
 * exist — so admin KYC document review returned "file physically missing" for
 * every trader, and the KYC quality-flag report scored every document as
 * absent. routes/admin/certificates.js, sitting in the same directory, had the
 * correct hop count, which is why the bug was invisible by inspection.
 *
 * Depth-relative paths are only correct until a file moves. Anchoring the root
 * here once means a call site can never get it wrong by being in the wrong
 * directory, because it no longer counts.
 */

import path from 'node:path'
import {
  DISPUTE_EVIDENCE_ROOT,
  KYC_UPLOADS_ROOT,
  RUNTIME_ROOT,
  TRADE_JOURNAL_ROOT,
  UPLOADS_ROOT
} from '../config/runtimePaths'

const BACKEND_ROOT = RUNTIME_ROOT

/**
 * Resolves a stored relative path against an uploads root, refusing anything
 * that escapes it.
 *
 * Stored paths come from the database and may carry a leading slash or an
 * `uploads/` prefix depending on which writer produced them, so both are
 * normalised away before resolution. The containment check runs on the
 * *resolved* path, which is what makes it a real guard: `..` segments are
 * already collapsed by path.resolve at that point, so there is nothing left to
 * smuggle through.
 *
 * @param {string} root absolute uploads root the result must stay inside
 * @param {string} relativePath stored path, relative to that root
 * @returns {string|null} absolute path, or null if it escapes
 */
function resolveWithinUploads(root: string, relativePath: string): string | null {
  if (!relativePath) return null
  const stripped = String(relativePath)
    .replace(/^[/\\]+/, '')
    .replace(/^uploads[/\\]+/i, '')
  const absolute = path.resolve(root, stripped)
  if (absolute !== root && !absolute.startsWith(root + path.sep)) return null
  return absolute
}

export {
  BACKEND_ROOT,
  UPLOADS_ROOT,
  KYC_UPLOADS_ROOT,
  DISPUTE_EVIDENCE_ROOT,
  TRADE_JOURNAL_ROOT,
  resolveWithinUploads
}
