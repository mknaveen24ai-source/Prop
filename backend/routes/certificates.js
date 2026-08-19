const express = require('express')
const router = express.Router()
const rateLimit = require('express-rate-limit')

const pool = require('../db')
// Public verification is unauthenticated and linked from every shared
// certificate, which makes it the easiest endpoint here to point a crawler at.
// It runs on the read pool, matching routes/transparency.js.
const { readPool } = require('../db')
const { authenticateToken } = require('./middleware')
const logger = require('../utils/logger')

const {
  getByPublicId, listForUser, describeVerification
} = require('../services/certificateService')
const { getTemplateById } = require('../services/certificateTemplateService')
const {
  buildCertificateSvg, renderCertificatePng, renderCertificatePdf
} = require('../services/certificateRenderer')
const { getCertificateVerifyUrl } = require('../utils/publicUrl')

// ─────────────────────────────────────────────────────────────────────────────
// Certificates — trader-facing and public verification.
//
// Everything lives under /api/ because deploy/nginx/propfirm.conf proxies only
// /api/, /api/auth/ and /socket.io/ to the backend; a top-level /verify path
// would be served the SPA instead.
//
// Rendering happens on demand from the row plus its PINNED template, so nothing
// is ever written to disk and a certificate looks the same in the viewer, the
// download, the email and the public page.
// ─────────────────────────────────────────────────────────────────────────────

// The global authLimiter covers only /api/auth. These endpoints rasterize
// images on request, so they carry their own budget.
const publicCertificateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many verification requests, please try again shortly.' }
})

const renderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many certificate renders, please try again shortly.' }
})

function parseRenderWidth(value) {
  const width = parseInt(value, 10)
  return Number.isFinite(width) ? width : null
}

async function loadTemplateFor(db, certificate) {
  return certificate.template_id ? getTemplateById(db, certificate.template_id) : null
}

/** Trader-safe projection. Never leaks user_id or the internal row id. */
function presentCertificate(certificate) {
  return {
    public_id: certificate.public_id,
    kind: certificate.kind,
    title: certificate.title,
    subtitle: certificate.subtitle,
    recipient_name: certificate.recipient_name,
    amount: certificate.amount,
    currency: certificate.currency,
    status: certificate.status,
    revoked_at: certificate.revoked_at,
    revoked_reason: certificate.revoked_reason,
    signature: certificate.signature,
    issued_at: certificate.issued_at,
    verify_url: getCertificateVerifyUrl(certificate.public_id)
  }
}

// ── Public verification ──────────────────────────────────────────────────────
// Mounted BEFORE the authenticated '/:publicId' routes: Express matches in
// registration order, and '/public/...' would otherwise be captured by the
// '/:publicId' parameter and rejected as someone else's certificate.

router.get('/public/:publicId', publicCertificateLimiter, async function(req, res) {
  try {
    const certificate = await getByPublicId(readPool, req.params.publicId)
    const verdict = describeVerification(certificate)

    if (!certificate) return res.status(404).json({ ...verdict, certificate: null })

    res.json({ ...verdict, certificate: presentCertificate(certificate) })
  } catch (error) {
    logger.error('Public certificate verification error:', { error: error.message })
    res.status(500).json({ error: 'Could not verify that certificate' })
  }
})

// Express 5 (path-to-regexp v8) removed inline regex parameters, so
// `render.:format(png|svg)` throws at mount time rather than matching. Each
// format gets its own explicit path.
function publicRenderHandler(format) {
  return async function(req, res) {
    try {
      const certificate = await getByPublicId(readPool, req.params.publicId)
      if (!certificate) return res.status(404).json({ error: 'Certificate not found' })

      const template = await loadTemplateFor(readPool, certificate)

      if (format === 'svg') {
        res.type('image/svg+xml').send(await buildCertificateSvg(certificate, template))
        return
      }
      const png = await renderCertificatePng(certificate, template, { width: parseRenderWidth(req.query.w) })
      res.type('image/png').send(png)
    } catch (error) {
      logger.error('Public certificate render error:', { error: error.message })
      res.status(500).json({ error: 'Could not render that certificate' })
    }
  }
}

router.get('/public/:publicId/render.png', publicCertificateLimiter, renderLimiter, publicRenderHandler('png'))
router.get('/public/:publicId/render.svg', publicCertificateLimiter, renderLimiter, publicRenderHandler('svg'))

// ── Trader-facing ────────────────────────────────────────────────────────────

router.get('/', authenticateToken, async function(req, res) {
  try {
    const rows = await listForUser(pool, req.user.userId)
    res.json(rows.map(presentCertificate))
  } catch (error) {
    logger.error('Fetch certificates error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch your certificates' })
  }
})

/**
 * Load one of the caller's own certificates, or send the response and return
 * null. Ownership is checked against req.user.userId on every render route —
 * a certificate ID is guessable-adjacent and appears in shared links, so the
 * authenticated routes must not serve one trader's certificate to another.
 */
async function loadOwnCertificate(req, res) {
  const certificate = await getByPublicId(pool, req.params.publicId)
  if (!certificate || String(certificate.user_id) !== String(req.user.userId)) {
    res.status(404).json({ error: 'Certificate not found' })
    return null
  }
  return certificate
}

router.get('/:publicId', authenticateToken, async function(req, res) {
  try {
    const certificate = await loadOwnCertificate(req, res)
    if (!certificate) return
    res.json({ ...describeVerification(certificate), certificate: presentCertificate(certificate) })
  } catch (error) {
    logger.error('Fetch certificate error:', { error: error.message })
    res.status(500).json({ error: 'Could not fetch that certificate' })
  }
})

function ownRenderHandler(format) {
  return async function(req, res) {
    try {
      const certificate = await loadOwnCertificate(req, res)
      if (!certificate) return

      const template = await loadTemplateFor(pool, certificate)
      const filename = `certificate-${certificate.public_id}`

      if (format === 'svg') {
        res.type('image/svg+xml').send(await buildCertificateSvg(certificate, template))
        return
      }

      if (format === 'pdf') {
        const pdf = await renderCertificatePdf(certificate, template)
        res.type('application/pdf')
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`)
        res.send(pdf)
        return
      }

      const png = await renderCertificatePng(certificate, template, { width: parseRenderWidth(req.query.w) })
      res.type('image/png')
      // The viewer requests this same URL without ?download, so the header is
      // set only when the trader actually asked to save the file.
      if (req.query.download === '1') {
        res.setHeader('Content-Disposition', `attachment; filename="${filename}.png"`)
      }
      res.send(png)
    } catch (error) {
      logger.error('Certificate render error:', { error: error.message })
      res.status(500).json({ error: 'Could not render that certificate' })
    }
  }
}

router.get('/:publicId/render.png', authenticateToken, renderLimiter, ownRenderHandler('png'))
router.get('/:publicId/render.svg', authenticateToken, renderLimiter, ownRenderHandler('svg'))
router.get('/:publicId/render.pdf', authenticateToken, renderLimiter, ownRenderHandler('pdf'))

module.exports = router
