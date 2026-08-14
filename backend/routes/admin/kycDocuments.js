// Admin authenticated KYC document streaming.
// Split verbatim out of the former 9,898-line routes/admin.js. Mounted at the
// router root by ./index.js, so every path below stays absolute under /api/admin.

const express = require('express')
const router = express.Router()
const pool = require('../../db')
const {
  authenticateAdmin,
  requireAdminCapability
} = require('../middleware')
const logger = require('../../utils/logger')
const { readKycFileBuffer, getKycContentType } = require('../../utils/secureKycStorage')
require('../../loadEnv')

const {
  appendImmutableAudit
} = require('./shared/audit')
const {
  buildAdminAuditActor
} = require('./shared/helpers')

// -- KYC Document Viewer -----------------------------------------------------------------------
router.get('/kyc/document/:userId/:type', authenticateAdmin, requireAdminCapability('kyc:review:scoped'), async (req, res) => {
  try {
    const { userId, type } = req.params;

    // FIX: kyc.js saves file paths into the `users` table (not `user_kyc`).
    // Column mapping: type='id' -> id_document_path | type='id_back' -> id_document_back_path | type='selfie' -> selfie_path
    const columnName = type === 'selfie' ? 'selfie_path' : type === 'id_back' ? 'id_document_back_path' : 'id_document_path';

    const userRow = await pool.query(
      `SELECT ${columnName} AS doc_path
         FROM users
        WHERE id = $1`,
      [userId]
    );

    if (userRow.rows.length === 0 || !userRow.rows[0].doc_path) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const path = require('path');
    const fs = require('fs');

    // kyc.js stores a relative path like "kyc/userId-id_document-xyz.jpg"
    // Strip any leading "uploads/" prefix in case the DB value includes it.
    const rawPath = userRow.rows[0].doc_path;
    const relPath = rawPath.replace(/^[\/\\\\]?uploads[\/\\\\]/, '');

    const uploadsRoot = path.resolve(__dirname, '..', 'uploads');
    const absoluteFilePath = path.resolve(uploadsRoot, relPath);

    // Path traversal guard -- reject any path that escapes the uploads directory.
    if (!absoluteFilePath.startsWith(uploadsRoot + path.sep)) {
      logger.warn('[kyc-doc] Path traversal attempt blocked:', { rawPath, userId });
      return res.status(400).json({ error: 'Invalid document path' });
    }

    if (!fs.existsSync(absoluteFilePath)) {
      return res.status(404).json({ error: 'File physically missing from server disk' });
    }

    try {
      await appendImmutableAudit(pool, {
        actor: buildAdminAuditActor(req.admin),
        eventType: 'kyc_document_viewed',
        entityType: 'user',
        entityId: String(userId),
        payload: { type: String(type || 'id') }
      })
    } catch (silentErr) { logger.warn("[admin] Non-critical operation failed silently:", { error: silentErr.message }) }

    // readKycFileBuffer transparently decrypts `.enc` files (AES-256-GCM at rest)
    // and passes legacy plaintext files straight through, so both eras of upload
    // are served the same way.
    let buffer
    try {
      buffer = readKycFileBuffer(absoluteFilePath).buffer
    } catch (decryptErr) {
      logger.error('[kyc-doc] Failed to decrypt document:', { error: decryptErr.message, userId, type });
      return res.status(500).json({ error: 'Failed to retrieve KYC document' });
    }
    res.setHeader('Content-Type', getKycContentType(absoluteFilePath));
    res.send(buffer);
  } catch (err) {
    logger.error('[kyc-doc] Error serving document:', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve KYC document' });
  }
});

module.exports = router
