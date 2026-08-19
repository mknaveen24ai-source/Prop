'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const pool = require('../db')
const logger = require('../utils/logger')
const { readImageDimensions } = require('../utils/imageDimensions')
const { normalizeLayout, DEFAULT_LAYOUT } = require('./certificateLayout')

/**
 * Certificate template storage.
 *
 * Templates are IMMUTABLE VERSIONS. Editing a layout inserts a new row with
 * version + 1 and deactivates the previous one, because certificates pin
 * `template_id` at issue time — a trader who downloaded and shared a
 * certificate must keep seeing exactly that artwork, however many times the
 * design is revised afterwards.
 *
 * A consequence worth remembering: several versions share one image file on
 * disk, so deleting a template must never unlink artwork another version still
 * points at. deleteTemplate() checks for that.
 *
 * Unlike KYC documents these files are NOT encrypted at rest. They are brand
 * assets, not personal data, and every certificate render has to read them.
 */

const UPLOADS_ROOT = path.resolve(__dirname, '..', 'uploads')
const TEMPLATE_SUBDIR = 'certificate-templates'
const TEMPLATE_DIR = path.join(UPLOADS_ROOT, TEMPLATE_SUBDIR)

const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
const MIN_IMAGE_WIDTH = 1600
const MIN_IMAGE_HEIGHT = 1100

const TEMPLATE_KINDS = ['phase_passed', 'funded', 'payout', 'custom']

const TEMPLATE_COLUMNS = `
  id, kind, version, is_active, name, image_path,
  image_width, image_height, layout, uploaded_by, created_at
`

function ensureTemplateDir() {
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true })
  return TEMPLATE_DIR
}

/**
 * Magic-byte verification, mirroring routes/kyc.js.
 *
 * multer's fileFilter only sees the client-declared Content-Type and the
 * filename, both of which the client controls, so the real check has to happen
 * against the bytes on disk.
 */
function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { ext: '.png', mime: 'image/png' }
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { ext: '.jpg', mime: 'image/jpeg' }
  }
  return null
}

class TemplateValidationError extends Error {
  constructor(message, statusCode = 400) {
    super(message)
    this.name = 'TemplateValidationError'
    this.statusCode = statusCode
  }
}

/**
 * Validate an uploaded buffer and write it into the uploads volume.
 * Returns the metadata a certificate_templates row needs.
 */
function persistTemplateImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new TemplateValidationError('No template image was uploaded')
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new TemplateValidationError('Template image must be 8MB or smaller')
  }

  const type = detectImageType(buffer)
  if (!type) {
    throw new TemplateValidationError('Template image must be a PNG or JPEG file')
  }

  const dimensions = readImageDimensions(buffer)
  if (!dimensions) {
    throw new TemplateValidationError('Could not read the dimensions of that image')
  }
  if (dimensions.width < MIN_IMAGE_WIDTH || dimensions.height < MIN_IMAGE_HEIGHT) {
    throw new TemplateValidationError(
      `Template must be at least ${MIN_IMAGE_WIDTH}x${MIN_IMAGE_HEIGHT}px (got ${dimensions.width}x${dimensions.height}px)`
    )
  }

  ensureTemplateDir()
  const filename = `${crypto.randomUUID()}${type.ext}`
  fs.writeFileSync(path.join(TEMPLATE_DIR, filename), buffer, { mode: 0o640 })

  return {
    imagePath: `${TEMPLATE_SUBDIR}/${filename}`,
    width: dimensions.width,
    height: dimensions.height,
    mime: type.mime
  }
}

function normalizeKind(kind) {
  const raw = String(kind == null ? '' : kind).trim()
  if (!raw || raw === 'default' || raw === '__default__') return null
  if (!TEMPLATE_KINDS.includes(raw)) {
    throw new TemplateValidationError(`Unknown certificate kind: ${raw}`)
  }
  return raw
}

/**
 * Resolution order: an active template for this exact kind, then the active
 * default (kind IS NULL), then null — which the renderer treats as "use the
 * built-in design". That last step is what makes the whole feature work on day
 * one with nothing uploaded.
 */
async function resolveTemplateForKind(db, kind) {
  const executor = db || pool
  const result = await executor.query(
    `SELECT ${TEMPLATE_COLUMNS}
       FROM certificate_templates
      WHERE is_active
        AND (kind = $1 OR kind IS NULL)
      ORDER BY (kind IS NULL) ASC
      LIMIT 1`,
    [kind || null]
  )
  return result.rows[0] || null
}

async function getTemplateById(db, id) {
  const executor = db || pool
  const result = await executor.query(
    `SELECT ${TEMPLATE_COLUMNS} FROM certificate_templates WHERE id = $1`,
    [id]
  )
  return result.rows[0] || null
}

async function listTemplates(db) {
  const executor = db || pool
  const result = await executor.query(
    `SELECT ${TEMPLATE_COLUMNS},
            (SELECT COUNT(*)::int FROM certificates c WHERE c.template_id = t.id) AS certificate_count
       FROM certificate_templates t
      ORDER BY is_active DESC, COALESCE(kind, '') ASC, version DESC`
  )
  return result.rows
}

/**
 * Deactivate whatever is currently active for a kind.
 *
 * The partial unique index (one active row per kind) means this MUST happen
 * before inserting the replacement, inside the same transaction, or the insert
 * violates the constraint.
 */
async function deactivateActiveForKind(executor, kind) {
  await executor.query(
    `UPDATE certificate_templates
        SET is_active = FALSE
      WHERE is_active
        AND kind IS NOT DISTINCT FROM $1`,
    [kind]
  )
}

async function nextVersionForKind(executor, kind) {
  const result = await executor.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next
       FROM certificate_templates
      WHERE kind IS NOT DISTINCT FROM $1`,
    [kind]
  )
  return result.rows[0].next
}

async function createTemplate(db, { kind, name, imagePath, width, height, layout, uploadedBy }) {
  const executor = db || pool
  const normalizedKind = normalizeKind(kind)

  await deactivateActiveForKind(executor, normalizedKind)
  const version = await nextVersionForKind(executor, normalizedKind)

  const result = await executor.query(
    `INSERT INTO certificate_templates
       (kind, version, is_active, name, image_path, image_width, image_height, layout, uploaded_by)
     VALUES ($1, $2, TRUE, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING ${TEMPLATE_COLUMNS}`,
    [
      normalizedKind,
      version,
      String(name || 'Untitled template').slice(0, 200),
      imagePath,
      width,
      height,
      JSON.stringify(normalizeLayout(layout || DEFAULT_LAYOUT)),
      uploadedBy || null
    ]
  )
  return result.rows[0]
}

/**
 * Saving a layout creates the NEXT version rather than mutating this row, so
 * certificates pinned to the current version keep rendering unchanged.
 */
async function saveTemplateLayout(db, id, layout, actor) {
  const executor = db || pool
  const existing = await getTemplateById(executor, id)
  if (!existing) throw new TemplateValidationError('Template not found', 404)

  await deactivateActiveForKind(executor, existing.kind)
  const version = await nextVersionForKind(executor, existing.kind)

  const result = await executor.query(
    `INSERT INTO certificate_templates
       (kind, version, is_active, name, image_path, image_width, image_height, layout, uploaded_by)
     VALUES ($1, $2, TRUE, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING ${TEMPLATE_COLUMNS}`,
    [
      existing.kind,
      version,
      existing.name,
      existing.image_path,
      existing.image_width,
      existing.image_height,
      JSON.stringify(normalizeLayout(layout)),
      actor || existing.uploaded_by || null
    ]
  )
  return result.rows[0]
}

async function activateTemplate(db, id) {
  const executor = db || pool
  const existing = await getTemplateById(executor, id)
  if (!existing) throw new TemplateValidationError('Template not found', 404)

  await deactivateActiveForKind(executor, existing.kind)
  const result = await executor.query(
    `UPDATE certificate_templates SET is_active = TRUE WHERE id = $1 RETURNING ${TEMPLATE_COLUMNS}`,
    [id]
  )
  return result.rows[0]
}

/**
 * Delete a template version.
 *
 * Refuses if certificates are pinned to it — those rows would lose their
 * artwork and silently fall back to the built-in design, which is precisely the
 * retroactive change the versioning scheme exists to prevent.
 */
async function deleteTemplate(db, id) {
  const executor = db || pool
  const existing = await getTemplateById(executor, id)
  if (!existing) throw new TemplateValidationError('Template not found', 404)

  const inUse = await executor.query(
    `SELECT COUNT(*)::int AS count FROM certificates WHERE template_id = $1`,
    [id]
  )
  if (inUse.rows[0].count > 0) {
    throw new TemplateValidationError(
      `This template is used by ${inUse.rows[0].count} issued certificate(s) and cannot be deleted`,
      409
    )
  }

  await executor.query(`DELETE FROM certificate_templates WHERE id = $1`, [id])

  // Versions share an image file. Only unlink once nothing else points at it.
  const stillReferenced = await executor.query(
    `SELECT COUNT(*)::int AS count FROM certificate_templates WHERE image_path = $1`,
    [existing.image_path]
  )
  if (stillReferenced.rows[0].count === 0) {
    try {
      fs.unlinkSync(path.resolve(UPLOADS_ROOT, existing.image_path))
    } catch (error) {
      // A missing or unlinkable file must not fail an already-committed delete.
      logger.warn('[certificateTemplates] Could not remove template image', {
        image_path: existing.image_path,
        error: error.message
      })
    }
  }

  return existing
}

module.exports = {
  TemplateValidationError,
  TEMPLATE_KINDS,
  MAX_UPLOAD_BYTES,
  MIN_IMAGE_WIDTH,
  MIN_IMAGE_HEIGHT,
  TEMPLATE_DIR,
  ensureTemplateDir,
  detectImageType,
  persistTemplateImage,
  normalizeKind,
  resolveTemplateForKind,
  getTemplateById,
  listTemplates,
  createTemplate,
  saveTemplateLayout,
  activateTemplate,
  deleteTemplate
}
