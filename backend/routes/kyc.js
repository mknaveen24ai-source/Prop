const express = require('express')
const router = express.Router()
const multer = require('multer')
const rateLimit = require('express-rate-limit')
const { ipKeyGenerator } = require('express-rate-limit')
const path = require('path')
const fs = require('fs')
const pool = require('../db')
const { authenticateToken } = require('./middleware')
const logger = require('../utils/logger')

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
  if (file.fieldname === 'id_document') {
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
const kycUploadLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,  // 24 hours
  max: 3,                          // 3 uploads per 24 hours per user
  message: { error: 'You can submit KYC documents 3 times per 24 hours. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.userId ? `user:${req.user.userId}` : ipKeyGenerator(req)
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
      if (!files || !files.id_document || !files.selfie) {
        return res.status(400).json({ error: 'Both ID document and selfie are required' })
      }

      const idDoc  = files.id_document[0]
      const selfie = files.selfie[0]
      uploadedFiles.push(idDoc.path, selfie.path)

      // ── FIX (Bug 13): Magic byte validation ────────────────────────────────
      // Check actual file contents, not just the header/extension.
      // Normalize 'jpeg' → 'jpg' so .jpeg files are accepted.
      const idDocExt  = path.extname(idDoc.originalname).toLowerCase().replace('.', '').replace('jpeg', 'jpg')
      const selfieExt = path.extname(selfie.originalname).toLowerCase().replace('.', '').replace('jpeg', 'jpg')

      const idAllowed  = ['jpg', 'png', 'pdf'].includes(idDocExt) ? [idDocExt === 'jpg' ? 'jpg' : idDocExt] : []
      const idMagicOk  = idAllowed.length > 0 && validateMagicBytes(idDoc.path, ['jpg', 'png', 'pdf'])

      const selfieAllowed = ['jpg', 'png'].includes(selfieExt)
      const selfieMagicOk = selfieAllowed && validateMagicBytes(selfie.path, ['jpg', 'png'])

      if (!idMagicOk) {
        // Clean up the uploaded files before returning the error
        uploadedFiles.forEach(f => { try { fs.unlinkSync(f) } catch (_) {} })
        return res.status(400).json({ error: 'ID document file content does not match declared type' })
      }

      if (!selfieMagicOk) {
        uploadedFiles.forEach(f => { try { fs.unlinkSync(f) } catch (_) {} })
        return res.status(400).json({ error: 'Selfie file content does not match declared type' })
      }

      // Fetch existing paths before overwriting (for cleanup)
      const existingResult = await pool.query(
        'SELECT id_document_path, selfie_path FROM users WHERE id = $1',
        [req.user.userId]
      )
      const existing = existingResult.rows[0] || {}

      const idDocRelPath  = toRelativePath(idDoc.path)
      const selfieRelPath = toRelativePath(selfie.path)

      await pool.query(
        `UPDATE users SET
         kyc_status = 'pending',
         id_document_path = $1,
         selfie_path = $2,
         kyc_submitted_at = NOW()
         WHERE id = $3`,
        [idDocRelPath, selfieRelPath, req.user.userId]
      )

      // Delete old files AFTER successful DB update
      if (existing.id_document_path && existing.id_document_path !== idDocRelPath) {
        deleteOldKycFile(existing.id_document_path)
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
      'SELECT kyc_status, kyc_submitted_at FROM users WHERE id = $1',
      [req.user.userId]
    )
    res.json(result.rows[0])
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch KYC status' })
  }
})

module.exports = router