// Admin certificate registry and template designer.
//
// Mounted at the router root by ./index.js, so every path below stays absolute
// under /api/admin.
//
// ROUTE ORDER IS LOAD-BEARING: `/certificates/templates*` is registered before
// `/certificates/:id*`, because Express matches in registration order and
// `:id` would otherwise capture the literal string "templates" and try to look
// up a certificate with that ID.

const express = require('express')
const router = express.Router()
const fs = require('fs')
const path = require('path')
const multer = require('multer')

const pool = require('../../db')
const logger = require('../../utils/logger')
const { authenticateAdmin, requireAdminCapability } = require('../middleware')
const { getAdminActorLabel, appendImmutableAudit } = require('./shared/audit')

const certificates = require('../../services/certificateService')
const templates = require('../../services/certificateTemplateService')
const { FIELD_DEFS, FONT_FAMILIES, FONT_WEIGHTS, TEXT_ALIGNMENTS, DEFAULT_LAYOUT, normalizeLayout } = require('../../services/certificateLayout')
const { renderCertificatePng, renderCertificatePdf } = require('../../services/certificateRenderer')
const { signCertificate } = require('../../utils/certificateSignature')

// Memory storage, not multer.diskStorage: persistTemplateImage does the
// magic-byte and dimension checks and owns where the file lands, so writing to
// disk first would only create a temp file to clean up on every rejection.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: templates.MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/png', 'image/jpeg', 'image/jpg']
    if (!allowed.includes(String(file.mimetype || '').toLowerCase())) {
      return cb(new Error('Template must be a PNG or JPEG image'))
    }
    cb(null, true)
  }
})

function handleTemplateError(res, error, fallbackMessage) {
  if (error && error.name === 'TemplateValidationError') {
    return res.status(error.statusCode || 400).json({ error: error.message })
  }
  logger.error(fallbackMessage, { error: error.message })
  return res.status(500).json({ error: fallbackMessage })
}

// ── Template designer ────────────────────────────────────────────────────────

/**
 * Everything the layout editor needs to render its controls without hardcoding
 * the field list, so adding a field to certificateLayout.js surfaces it in the
 * admin UI automatically instead of requiring a matching frontend edit.
 */
router.get('/certificates/templates/schema', authenticateAdmin, requireAdminCapability('certificate:template:manage'), function(req, res) {
  res.json({
    fields: FIELD_DEFS,
    fonts: FONT_FAMILIES,
    weights: FONT_WEIGHTS,
    alignments: TEXT_ALIGNMENTS,
    defaultLayout: DEFAULT_LAYOUT,
    kinds: templates.TEMPLATE_KINDS,
    constraints: {
      maxUploadBytes: templates.MAX_UPLOAD_BYTES,
      minWidth: templates.MIN_IMAGE_WIDTH,
      minHeight: templates.MIN_IMAGE_HEIGHT
    }
  })
})

router.get('/certificates/templates', authenticateAdmin, requireAdminCapability('certificate:template:manage'), async function(req, res) {
  try {
    res.json({ templates: await templates.listTemplates(pool) })
  } catch (error) {
    handleTemplateError(res, error, 'Could not fetch certificate templates')
  }
})

router.post(
  '/certificates/templates',
  authenticateAdmin,
  requireAdminCapability('certificate:template:manage'),
  function(req, res, next) {
    upload.single('template')(req, res, function(err) {
      if (err) {
        // multer's own size/type errors are the admin's mistake, not a 500.
        return res.status(400).json({
          error: err.code === 'LIMIT_FILE_SIZE'
            ? 'Template image must be 8MB or smaller'
            : err.message
        })
      }
      next()
    })
  },
  async function(req, res) {
    try {
      if (!req.file) return res.status(400).json({ error: 'No template image was uploaded' })

      const stored = templates.persistTemplateImage(req.file.buffer)
      const template = await templates.createTemplate(pool, {
        kind: req.body.kind || null,
        name: req.body.name || req.file.originalname || 'Certificate template',
        imagePath: stored.imagePath,
        width: stored.width,
        height: stored.height,
        layout: req.body.layout ? JSON.parse(req.body.layout) : DEFAULT_LAYOUT,
        uploadedBy: getAdminActorLabel(req.admin)
      })

      await appendImmutableAudit(pool, {
        eventType: 'certificate_template_uploaded',
        entityType: 'certificate_template',
        entityId: String(template.id),
        actor: getAdminActorLabel(req.admin),
        payload: { kind: template.kind, version: template.version, width: stored.width, height: stored.height }
      })

      res.status(201).json({ template })
    } catch (error) {
      handleTemplateError(res, error, 'Could not save that certificate template')
    }
  }
)

router.get('/certificates/templates/:id/image', authenticateAdmin, requireAdminCapability('certificate:template:manage'), async function(req, res) {
  try {
    const template = await templates.getTemplateById(pool, req.params.id)
    if (!template) return res.status(404).json({ error: 'Template not found' })

    // NOTE: '..', '..' — this file lives in routes/admin/, two levels below
    // backend/. routes/admin/kycDocuments.js resolves this with a single '..'
    // and consequently reads backend/routes/uploads, which does not exist.
    const uploadsRoot = path.resolve(__dirname, '..', '..', 'uploads')
    const absolute = path.resolve(uploadsRoot, String(template.image_path).replace(/^[/\\]+/, ''))
    if (!absolute.startsWith(uploadsRoot + path.sep)) {
      return res.status(400).json({ error: 'Invalid template path' })
    }
    if (!fs.existsSync(absolute)) return res.status(404).json({ error: 'Template image is missing from disk' })

    res.type(absolute.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg')
    res.sendFile(absolute)
  } catch (error) {
    handleTemplateError(res, error, 'Could not load that template image')
  }
})

/**
 * Server-rendered preview with sample data.
 *
 * The editor canvas is HTML/CSS and the real output is resvg; the two will
 * never agree perfectly on text metrics. This endpoint is the ground truth the
 * admin checks their layout against, which is why it goes through exactly the
 * same renderer a real certificate does.
 *
 * Accepts an optional `layout` in the body so unsaved edits can be previewed.
 */
router.post('/certificates/templates/:id/preview', authenticateAdmin, requireAdminCapability('certificate:template:manage'), async function(req, res) {
  try {
    const template = await templates.getTemplateById(pool, req.params.id)
    if (!template) return res.status(404).json({ error: 'Template not found' })

    const preview = { ...template }
    if (req.body && req.body.layout) preview.layout = normalizeLayout(req.body.layout)

    const sample = Object.fromEntries(FIELD_DEFS.filter((f) => f.sample).map((f) => [f.key, f.sample]))
    const fixture = {
      public_id: sample.public_id,
      user_id: '00000000-0000-0000-0000-000000000000',
      kind: template.kind || 'funded',
      title: sample.title,
      subtitle: sample.subtitle,
      recipient_name: sample.recipient_name,
      amount: 100000,
      currency: 'USD',
      status: 'active',
      issued_at: new Date()
    }
    fixture.signature = signCertificate(fixture)

    const png = await renderCertificatePng(fixture, preview, { width: parseInt(req.query.w, 10) || 1400 })
    res.type('image/png').send(png)
  } catch (error) {
    handleTemplateError(res, error, 'Could not render a preview of that template')
  }
})

router.put('/certificates/templates/:id/layout', authenticateAdmin, requireAdminCapability('certificate:template:manage'), async function(req, res) {
  try {
    const template = await templates.saveTemplateLayout(pool, req.params.id, req.body?.layout, getAdminActorLabel(req.admin))
    await appendImmutableAudit(pool, {
      eventType: 'certificate_template_layout_saved',
      entityType: 'certificate_template',
      entityId: String(template.id),
      actor: getAdminActorLabel(req.admin),
      payload: { kind: template.kind, version: template.version, supersedes: String(req.params.id) }
    })
    res.json({ template })
  } catch (error) {
    handleTemplateError(res, error, 'Could not save that layout')
  }
})

router.post('/certificates/templates/:id/activate', authenticateAdmin, requireAdminCapability('certificate:template:manage'), async function(req, res) {
  try {
    res.json({ template: await templates.activateTemplate(pool, req.params.id) })
  } catch (error) {
    handleTemplateError(res, error, 'Could not activate that template')
  }
})

router.delete('/certificates/templates/:id', authenticateAdmin, requireAdminCapability('certificate:template:manage'), async function(req, res) {
  try {
    await templates.deleteTemplate(pool, req.params.id)
    res.json({ message: 'Template deleted' })
  } catch (error) {
    handleTemplateError(res, error, 'Could not delete that template')
  }
})

// ── Issued certificate registry ──────────────────────────────────────────────

router.get('/certificates', authenticateAdmin, requireAdminCapability('certificate:read:scoped'), async function(req, res) {
  try {
    const result = await certificates.listCertificates(pool, {
      q: req.query.search || req.query.q || '',
      kind: req.query.kind || '',
      status: req.query.status || '',
      page: req.query.page,
      pageSize: req.query.pageSize
    })
    res.json(result)
  } catch (error) {
    logger.error('Admin certificate list error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch certificates' })
  }
})

/** Manually award a custom certificate. */
router.post('/certificates', authenticateAdmin, requireAdminCapability('certificate:issue'), async function(req, res) {
  const client = await pool.connect()
  try {
    const { user_id, title, subtitle, amount, kind } = req.body || {}
    if (!user_id) return res.status(400).json({ error: 'user_id is required' })
    if (!title) return res.status(400).json({ error: 'title is required' })

    await client.query('BEGIN')
    const recipient = await client.query(`SELECT id, full_name, email FROM users WHERE id = $1`, [user_id])
    if (recipient.rows.length === 0) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Trader not found' })
    }

    const { certificate } = await certificates.issueCertificate(client, {
      userId: user_id,
      kind: certificates.CERTIFICATE_KINDS.includes(kind) ? kind : 'custom',
      title: String(title).slice(0, 200),
      subtitle: subtitle ? String(subtitle).slice(0, 300) : null,
      recipientName: recipient.rows[0].full_name,
      amount: amount === '' || amount === undefined || amount === null ? null : Number(amount),
      // Manual awards deliberately carry no sourceKey: the partial unique index
      // skips NULLs, so an admin can award the same honour more than once.
      sourceKey: null,
      issuedBy: getAdminActorLabel(req.admin)
    })

    await appendImmutableAudit(client, {
      eventType: 'certificate_manually_awarded',
      entityType: 'certificate',
      entityId: String(certificate.id),
      actor: getAdminActorLabel(req.admin),
      payload: { user_id: String(user_id), title: certificate.title, kind: certificate.kind }
    })

    await client.query('COMMIT')

    await certificates.deliverCertificate(req.app.get('io'), certificate, { email: recipient.rows[0].email })
    res.status(201).json({ certificate })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Manual certificate award error:', { error: error.message })
    res.status(500).json({ error: 'Could not award that certificate' })
  } finally {
    client.release()
  }
})

/**
 * Re-issue against the CURRENT template. Because template_id is pinned at issue
 * time, this is the only way to move an existing certificate onto a redesigned
 * template — the original is superseded rather than deleted, so a QR already in
 * circulation resolves to "revoked / superseded" instead of "not found".
 */
router.post('/certificates/:id/reissue', authenticateAdmin, requireAdminCapability('certificate:issue'), async function(req, res) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const certificate = await certificates.reissueCertificate(client, req.params.id, {
      actor: getAdminActorLabel(req.admin)
    })
    if (!certificate) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Certificate not found' })
    }

    await appendImmutableAudit(client, {
      eventType: 'certificate_reissued',
      entityType: 'certificate',
      entityId: String(certificate.id),
      actor: getAdminActorLabel(req.admin),
      payload: { new_public_id: certificate.public_id, superseded: String(req.params.id) }
    })
    await client.query('COMMIT')

    const recipient = await pool.query(`SELECT email FROM users WHERE id = $1`, [certificate.user_id])
    await certificates.deliverCertificate(req.app.get('io'), certificate, { email: recipient.rows[0]?.email || null })

    res.json({ certificate })
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    logger.error('Certificate reissue error:', { error: error.message })
    res.status(500).json({ error: 'Could not re-issue that certificate' })
  } finally {
    client.release()
  }
})

router.post('/certificates/:id/revoke', authenticateAdmin, requireAdminCapability('certificate:revoke'), async function(req, res) {
  try {
    const reason = String(req.body?.reason || '').trim()
    if (!reason) return res.status(400).json({ error: 'A reason is required to revoke a certificate' })

    const certificate = await certificates.revokeCertificate(pool, req.params.id, {
      reason,
      actor: getAdminActorLabel(req.admin)
    })
    if (!certificate) return res.status(404).json({ error: 'Certificate not found, or already revoked' })

    await appendImmutableAudit(pool, {
      eventType: 'certificate_revoked',
      entityType: 'certificate',
      entityId: String(certificate.id),
      actor: getAdminActorLabel(req.admin),
      payload: { public_id: certificate.public_id, reason }
    })

    res.json({ certificate })
  } catch (error) {
    logger.error('Certificate revoke error:', { error: error.message })
    res.status(500).json({ error: 'Could not revoke that certificate' })
  }
})

router.get('/certificates/:id/render.pdf', authenticateAdmin, requireAdminCapability('certificate:read:scoped'), async function(req, res) {
  try {
    const certificate = await certificates.getById(pool, req.params.id)
    if (!certificate) return res.status(404).json({ error: 'Certificate not found' })

    const template = certificate.template_id ? await templates.getTemplateById(pool, certificate.template_id) : null
    const pdf = await renderCertificatePdf(certificate, template)
    res.type('application/pdf')
    res.setHeader('Content-Disposition', `attachment; filename="certificate-${certificate.public_id}.pdf"`)
    res.send(pdf)
  } catch (error) {
    logger.error('Admin certificate render error:', { error: error.message })
    res.status(500).json({ error: 'Could not render that certificate' })
  }
})

module.exports = router
