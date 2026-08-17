const express = require('express')
const router = express.Router()
const multer = require('multer')
const { createLimiter } = require('../utils/security')
const { ipKeyGenerator } = require('express-rate-limit')
const path = require('path')
const fs = require('fs')
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const logger = require('../utils/logger')
const { encryptFileAtRest, readKycFileBuffer, getKycContentType } = require('../utils/secureKycStorage')
const { sanitizeString } = require('../utils/validation')
const {
  recordSignals,
  normalizeKycDocument,
  SIGNAL_TYPES
} = require('../services/identitySignals')

// Ensure upload directory exists
const uploadDir = path.join(__dirname, '../uploads/kyc')
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

// Configure multer storage
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9)
    const ext = path.extname(file.originalname)
    cb(null, req.user.userId + '-' + file.fieldname + '-' + uniqueSuffix + ext)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// File type validation — extension + MIME type (checked by multer on upload)
// FIX: Magic byte validation added in the route handler below, so a client
// cannot bypass the filter by sending a fake Content-Type header.
// ─────────────────────────────────────────────────────────────────────────────
const idDocFilter = (req, file, cb) => {
  if (file.fieldname === 'id_document' || file.fieldname === 'id_document_back') {
    const allowedTypes = /jpeg|jpg|png|pdf/
    const ext    = allowedTypes.test(path.extname(file.originalname).toLowerCase())
    const mimeOk = /image\/(jpeg|jpg|png)|application\/pdf/.test(file.mimetype)
    if (ext && mimeOk) return cb(null, true)
    return cb(new Error('ID document must be JPG, PNG or PDF'))
  }
  if (file.fieldname === 'selfie') {
    const allowedTypes = /jpeg|jpg|png/
    const ext    = allowedTypes.test(path.extname(file.originalname).toLowerCase())
    const mimeOk = /image\/(jpeg|jpg|png)/.test(file.mimetype)
    if (ext && mimeOk) return cb(null, true)
    return cb(new Error('Selfie must be a JPG or PNG image — PDFs not accepted'))
  }
  cb(new Error('Unexpected field'))
}

const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: idDocFilter
})

// ─────────────────────────────────────────────────────────────────────────────
// Magic byte signatures for server-side file type validation.
//
// FIX: multer's fileFilter only checks the Content-Type header and extension,
// both of which a client can spoof. Reading the first bytes of the actual file
// data is the only reliable way to verify file type.
// ─────────────────────────────────────────────────────────────────────────────
const MAGIC_BYTES = {
  jpg:  [Buffer.from([0xFF, 0xD8, 0xFF])],
  png:  [Buffer.from([0x89, 0x50, 0x4E, 0x47])],
  pdf:  [Buffer.from([0x25, 0x50, 0x44, 0x46])],  // %PDF
}

function readMagicBytes(filePath, numBytes) {
  const fd  = fs.openSync(filePath, 'r')
  const buf = Buffer.alloc(numBytes)
  fs.readSync(fd, buf, 0, numBytes, 0)
  fs.closeSync(fd)
  return buf
}

function validateMagicBytes(filePath, allowedTypes) {
  try {
    const header = readMagicBytes(filePath, 8)
    for (const type of allowedTypes) {
      const sigs = MAGIC_BYTES[type] || []
      for (const sig of sigs) {
        if (header.subarray(0, sig.length).equals(sig)) return true
      }
    }
    return false
  } catch {
    return false
  }
}

// Helper: convert absolute path → relative path from uploads/ root
function toRelativePath(absolutePath) {
  const uploadsIndex = absolutePath.indexOf(`${path.sep}uploads${path.sep}`)
  if (uploadsIndex !== -1) {
    return absolutePath.substring(uploadsIndex + `${path.sep}uploads${path.sep}`.length)
  }
  return path.basename(absolutePath)
}

// Helper: safely delete an old KYC file (non-fatal)
function deleteOldKycFile(relativePath) {
  if (!relativePath) return
  try {
    const absolutePath = path.join(__dirname, '../uploads', relativePath)
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath)
      logger.info(`[kyc] Deleted old file: ${relativePath}`)
    }
  } catch (err) {
    logger.warn(`[kyc] Could not delete old file ${relativePath}:`, { error: err.message })
  }
}

// FIX (H3): KYC submission rate limiting - prevent flooding with uploads
const kycUploadLimiter = createLimiter('kyc-upload', {
  windowMs: 24 * 60 * 60 * 1000,  // 24 hours
  max: 3,                          // 3 uploads per 24 hours per user
  message: { error: 'You can submit KYC documents 3 times per 24 hours. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.userId ? `user:${req.user.userId}` : ipKeyGenerator(req.ip)
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/kyc/upload
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload',
  kycUploadLimiter,
  authenticateToken,
  function(req, res, next) {
    upload.fields([
      { name: 'id_document', maxCount: 1 },
      { name: 'id_document_back', maxCount: 1 },
      { name: 'selfie', maxCount: 1 }
    ])(req, res, function(err) {
      if (err instanceof multer.MulterError) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(400).json({ error: 'File too large — maximum 5MB per file' })
        }
        return res.status(400).json({ error: err.message })
      }
      if (err) {
        return res.status(400).json({ error: err.message })
      }
      next()
    })
  },
  async function(req, res) {
    const uploadedFiles = []
    try {
      const files = req.files
      if (!files || Object.keys(files).length === 0) {
        return res.status(400).json({ error: 'At least one document is required' })
      }

      // Fetch existing paths/metadata first — a resubmission after rejection
      // may only replace one of the three documents; whatever isn't resent
      // here falls back to what's already on file (must exist for a
      // first-time submission, where nothing is on file yet).
      const existingResult = await pool.query(
        `SELECT id_document_path, id_document_back_path, selfie_path,
                kyc_document_country, kyc_document_type, kyc_document_number
           FROM users WHERE id = $1`,
        [req.user.userId]
      )
      const existing = existingResult.rows[0] || {}

      const idDoc     = files.id_document?.[0] || null
      const idDocBack = files.id_document_back?.[0] || null
      const selfie    = files.selfie?.[0] || null
      if (idDoc) uploadedFiles.push(idDoc.path)
      if (idDocBack) uploadedFiles.push(idDocBack.path)
      if (selfie) uploadedFiles.push(selfie.path)

      if (!idDoc && !existing.id_document_path) {
        return res.status(400).json({ error: 'ID document (front) is required' })
      }
      if (!idDocBack && !existing.id_document_back_path) {
        return res.status(400).json({ error: 'ID document (back) is required' })
      }
      if (!selfie && !existing.selfie_path) {
        return res.status(400).json({ error: 'A selfie is required' })
      }

      // ── FIX (Bug 13): Magic byte validation ────────────────────────────────
      // Check actual file contents, not just the header/extension.
      // Normalize 'jpeg' → 'jpg' so .jpeg files are accepted.
      function extOf(file) {
        return path.extname(file.originalname).toLowerCase().replace('.', '').replace('jpeg', 'jpg')
      }

      if (idDoc) {
        const ok = ['jpg', 'png', 'pdf'].includes(extOf(idDoc)) && validateMagicBytes(idDoc.path, ['jpg', 'png', 'pdf'])
        if (!ok) {
          uploadedFiles.forEach(f => { try { fs.unlinkSync(f) } catch (_) {} })
          return res.status(400).json({ error: 'ID document file content does not match declared type' })
        }
      }
      if (idDocBack) {
        const ok = ['jpg', 'png', 'pdf'].includes(extOf(idDocBack)) && validateMagicBytes(idDocBack.path, ['jpg', 'png', 'pdf'])
        if (!ok) {
          uploadedFiles.forEach(f => { try { fs.unlinkSync(f) } catch (_) {} })
          return res.status(400).json({ error: 'ID document back file content does not match declared type' })
        }
      }
      if (selfie) {
        const ok = ['jpg', 'png'].includes(extOf(selfie)) && validateMagicBytes(selfie.path, ['jpg', 'png'])
        if (!ok) {
          uploadedFiles.forEach(f => { try { fs.unlinkSync(f) } catch (_) {} })
          return res.status(400).json({ error: 'Selfie file content does not match declared type' })
        }
      }

      // Encrypt only the files actually submitted this request. encryptFileAtRest
      // writes a sibling `.enc` file and removes the plaintext original, so from
      // here on the tracked paths (for cleanup and for the DB) must be the
      // `.enc` ones. Anything not resubmitted keeps its existing stored path.
      let idDocRelPath = existing.id_document_path
      let idDocBackRelPath = existing.id_document_back_path
      let selfieRelPath = existing.selfie_path
      try {
        if (idDoc) idDocRelPath = toRelativePath(encryptFileAtRest(idDoc.path))
        if (idDocBack) idDocBackRelPath = toRelativePath(encryptFileAtRest(idDocBack.path))
        if (selfie) selfieRelPath = toRelativePath(encryptFileAtRest(selfie.path))
      } catch (encError) {
        logger.error('[kyc] Failed to encrypt uploaded documents:', { error: encError.message })
        uploadedFiles.forEach(f => { try { fs.unlinkSync(f) } catch (_) {} })
        return res.status(500).json({ error: 'Document storage is temporarily unavailable. Please try again later.' })
      }

      // Metadata fields (country/document type/number) are optional on a
      // partial resubmission — fall back to what's already on file rather
      // than clobbering them with blanks.
      const country        = sanitizeString(String(req.body.country || ''), 100) || existing.kyc_document_country || null
      const documentType   = sanitizeString(String(req.body.document_type || ''), 40) || existing.kyc_document_type || null
      const documentNumber = sanitizeString(String(req.body.document_number || ''), 64) || existing.kyc_document_number || null

      await pool.query(
        `UPDATE users SET
         kyc_status = 'pending',
         id_document_path = $1,
         id_document_back_path = $2,
         selfie_path = $3,
         kyc_document_country = $4,
         kyc_document_type = $5,
         kyc_document_number = $6,
         kyc_submitted_at = NOW()
         WHERE id = $7`,
        [idDocRelPath, idDocBackRelPath, selfieRelPath, country, documentType, documentNumber, req.user.userId]
      )

      // A passport re-used across "unrelated" accounts is either the same person
      // or a rented identity — either way it links them. kyc_document_number has
      // never had any uniqueness or duplicate check; this records it as a signal
      // (hashed, scoped by country) so the linking scan can find the reuse.
      const kycSignal = normalizeKycDocument(documentNumber, country)
      if (kycSignal) {
        recordSignals(
          req.user.userId,
          [{ type: SIGNAL_TYPES.KYC_DOC, value: kycSignal }],
          'kyc'
        )
      }

      // Delete old files AFTER successful DB update — only the ones actually replaced.
      if (existing.id_document_path && existing.id_document_path !== idDocRelPath) {
        deleteOldKycFile(existing.id_document_path)
      }
      if (existing.id_document_back_path && existing.id_document_back_path !== idDocBackRelPath) {
        deleteOldKycFile(existing.id_document_back_path)
      }
      if (existing.selfie_path && existing.selfie_path !== selfieRelPath) {
        deleteOldKycFile(existing.selfie_path)
      }

      res.json({ message: 'KYC documents uploaded successfully', status: 'pending' })
    } catch (error) {
      // If DB update fails, clean up newly uploaded files to prevent orphans
      uploadedFiles.forEach(f => { try { fs.unlinkSync(f) } catch (_) {} })
      logger.error('KYC upload error:', { error: error.message })
      res.status(500).json({ error: 'Upload failed' })
    }
  }
)

// GET /api/kyc/status
router.get('/status', authenticateToken, async function(req, res) {
  try {
    const result = await pool.query(
      `SELECT kyc_status, kyc_submitted_at, kyc_rejection_reason,
              kyc_document_country, kyc_document_type, kyc_document_number,
              (id_document_path IS NOT NULL) AS has_id_document,
              (id_document_back_path IS NOT NULL) AS has_id_document_back,
              (selfie_path IS NOT NULL) AS has_selfie
         FROM users WHERE id = $1`,
      [req.user.userId]
    )
    res.json(result.rows[0])
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch KYC status' })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/kyc/document/:type
// A trader viewing one of their own submitted KYC documents (real preview,
// not the decorative placeholder DashboardKYCPage used to show). Scoped to
// req.user.userId only — mirrors the admin viewer at
// admin.js's GET /kyc/document/:userId/:type but without the admin
// capability gate, since a trader is always allowed to see their own file.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/document/:type', authenticateToken, async function(req, res) {
  try {
    const { type } = req.params
    const columnName = type === 'selfie' ? 'selfie_path' : type === 'id_back' ? 'id_document_back_path' : 'id_document_path'
    if (!['id', 'id_back', 'selfie'].includes(type)) {
      return res.status(400).json({ error: 'Invalid document type' })
    }

    const userRow = await pool.query(
      `SELECT ${columnName} AS doc_path FROM users WHERE id = $1`,
      [req.user.userId]
    )

    if (userRow.rows.length === 0 || !userRow.rows[0].doc_path) {
      return res.status(404).json({ error: 'Document not found' })
    }

    const rawPath = userRow.rows[0].doc_path
    const relPath = rawPath.replace(/^[/\\]?uploads[/\\]/, '')
    const uploadsRoot = path.resolve(__dirname, '..', 'uploads')
    const absoluteFilePath = path.resolve(uploadsRoot, relPath)

    if (!absoluteFilePath.startsWith(uploadsRoot + path.sep)) {
      logger.warn('[kyc-doc] Path traversal attempt blocked:', { rawPath, userId: req.user.userId })
      return res.status(400).json({ error: 'Invalid document path' })
    }

    if (!fs.existsSync(absoluteFilePath)) {
      return res.status(404).json({ error: 'File physically missing from server disk' })
    }

    let buffer
    try {
      buffer = readKycFileBuffer(absoluteFilePath).buffer
    } catch (decryptErr) {
      logger.error('[kyc-doc] Failed to decrypt document:', { error: decryptErr.message, userId: req.user.userId, type })
      return res.status(500).json({ error: 'Failed to retrieve document' })
    }
    res.setHeader('Content-Type', getKycContentType(absoluteFilePath))
    res.send(buffer)
  } catch (error) {
    logger.error('[kyc-doc] Error serving document:', { error: error.message })
    res.status(500).json({ error: 'Failed to retrieve document' })
  }
})

module.exports = router