'use strict'

const fs = require('fs')
const path = require('path')
const QRCode = require('qrcode')
const { Resvg } = require('@resvg/resvg-js')
const PDFDocument = require('pdfkit')

const { FONT_FAMILIES, FIELD_DEFS, normalizeLayout } = require('./certificateLayout')
const { getCertificateVerifyUrl } = require('../utils/publicUrl')
const { formatSignatureForDisplay } = require('../utils/certificateSignature')

/**
 * Certificate rendering: one SVG master, three outputs.
 *
 *   buildCertificateSvg()  -> string   the single source of truth
 *     |- renderCertificatePng()  -> Buffer   via resvg
 *     `- renderCertificatePdf()  -> Buffer   via pdfkit, embedding that PNG
 *
 * An uploaded template swaps ONLY the background layer; field placement,
 * typography and the QR are identical either way. That is what keeps the
 * built-in fallback and a customer-designed template from drifting into two
 * codebases.
 *
 * FONTS ARE LOADED THROUGH RESVG'S OPTIONS, NOT CSS. resvg has no @font-face
 * support, so base64-embedding a face in the SVG does nothing at all — it
 * silently falls back to the default family and the output looks subtly wrong
 * in a way that only shows up in production. They must be passed as file paths,
 * and loadSystemFonts must be false so a developer machine full of fonts
 * renders byte-identically to a bare Alpine container.
 */

const FONTS_DIR = path.resolve(__dirname, '..', 'assets', 'fonts')

const FONT_FILES = [
  'PlayfairDisplay-Regular.ttf',
  'PlayfairDisplay-Bold.ttf',
  'IBMPlexMono-Regular.ttf',
  'IBMPlexMono-Bold.ttf',
  'SourceSerif4-Regular.ttf',
  'SourceSerif4-SemiBold.ttf'
].map((file) => path.join(FONTS_DIR, file))

// Built-in canvas. Uploaded templates use their own intrinsic dimensions.
const BUILTIN_WIDTH = 1600
const BUILTIN_HEIGHT = 1100

// Output floor/ceiling. A small uploaded template still gets upscaled to
// something worth downloading; a huge one does not turn into a 40MB PNG.
const MIN_RENDER_WIDTH = 2400
const MAX_RENDER_WIDTH = 4000

const PALETTE = {
  paper: '#0C0B0A',
  panel: '#161412',
  ink: '#EDE9E0',
  rule: '#3A3733',
  muted: '#8C8880',
  gold: '#E8B400',
  goldStrong: '#F5C518',
  loss: '#E05A5A'
}

let fontCheckResult = null

/**
 * Verified once per process. A missing font file is a deployment error, not a
 * per-request one, and resvg would otherwise degrade silently to its fallback.
 */
function assertFontsAvailable() {
  if (fontCheckResult === true) return
  if (fontCheckResult instanceof Error) throw fontCheckResult

  const missing = FONT_FILES.filter((file) => !fs.existsSync(file))
  if (missing.length > 0) {
    fontCheckResult = new Error(
      `Certificate fonts missing from ${FONTS_DIR}: ${missing.map((f) => path.basename(f)).join(', ')}`
    )
    fontCheckResult.code = 'CERTIFICATE_FONTS_MISSING'
    throw fontCheckResult
  }
  fontCheckResult = true
}

function resvgFontOptions() {
  return {
    fontFiles: FONT_FILES,
    loadSystemFonts: false,
    defaultFontFamily: FONT_FAMILIES.display
  }
}

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** Trims a float to 3dp so the SVG does not carry 17 digits of noise. */
function n(value) {
  return Math.round(Number(value) * 1000) / 1000
}

function formatMoney(amount, currency) {
  if (amount === null || amount === undefined || amount === '') return ''
  const number = Number(amount)
  if (!Number.isFinite(number)) return ''
  const formatted = number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency && currency !== 'USD' ? `${formatted} ${currency}` : `$${formatted}`
}

function formatIssueDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  // Explicit UTC: a certificate issued at 23:30 UTC must not read as a
  // different date depending on which server rendered it.
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
}

/** The display string for each layout field, derived from the certificate row. */
function fieldValue(certificate, key) {
  switch (key) {
    case 'recipient_name': return String(certificate.recipient_name || '')
    case 'title': return String(certificate.title || '')
    case 'subtitle': return String(certificate.subtitle || '')
    case 'amount': return formatMoney(certificate.amount, certificate.currency)
    case 'issue_date': return formatIssueDate(certificate.issued_at)
    case 'public_id': return String(certificate.public_id || '')
    case 'signature': return formatSignatureForDisplay(certificate.signature)
    default: return ''
  }
}

// Rough advance-width ratios (em per character) for the three shipped families,
// used only to decide whether to shrink an over-long line. Approximate by
// design: resvg does the real layout, this just prevents a 40-character name
// from running off a certificate nobody previewed.
const CHAR_WIDTH_RATIO = { display: 0.53, ui: 0.50, mono: 0.60 }

/**
 * Shrink factor for an over-long line, applied to the font size AND the letter
 * spacing together.
 *
 * Scaling only the font size cannot work: letter spacing is a fixed per-glyph
 * advance, so a heavily-tracked line keeps its tracking width no matter how
 * small the glyphs get and still overflows. Returning one factor for both is
 * what actually makes the estimate satisfiable.
 */
function fitScale(text, fontSize, fontKey, availableWidth, letterSpacingPx) {
  const ratio = CHAR_WIDTH_RATIO[fontKey] || 0.55
  const estimated = text.length * (fontSize * ratio + letterSpacingPx)
  if (estimated <= availableWidth || estimated <= 0) return 1
  return availableWidth / estimated
}

const ANCHOR_BY_ALIGN = { left: 'start', center: 'middle', right: 'end' }

/**
 * Horizontal room a field has before it runs off the canvas, given its anchor.
 * A left-aligned field at x=0.14 can use everything to its right; a centred one
 * is limited by whichever side is tighter, doubled.
 */
function availableWidthFor(align, x, canvasWidth) {
  const margin = 0.07
  if (align === 'left') return Math.max(0.1, 1 - x - margin) * canvasWidth
  if (align === 'right') return Math.max(0.1, x - margin) * canvasWidth
  return Math.max(0.1, Math.min(x - margin, 1 - x - margin) * 2) * canvasWidth
}

function renderTextField(certificate, key, field, width, height) {
  if (!field.visible) return ''
  let text = fieldValue(certificate, key)
  if (!text) return ''
  if (field.uppercase) text = text.toUpperCase()

  const baseSpacing = field.letterSpacing * height
  const baseSize = field.size * height
  const scale = fitScale(
    text, baseSize, field.font,
    availableWidthFor(field.align, field.x, width),
    baseSpacing
  )
  const fontSize = baseSize * scale
  const letterSpacingPx = baseSpacing * scale

  const attrs = [
    `x="${n(field.x * width)}"`,
    `y="${n(field.y * height)}"`,
    `font-family="${escapeXml(FONT_FAMILIES[field.font] || FONT_FAMILIES.display)}"`,
    `font-size="${n(fontSize)}"`,
    `font-weight="${field.weight}"`,
    `fill="${field.color}"`,
    `text-anchor="${ANCHOR_BY_ALIGN[field.align] || 'middle'}"`
  ]
  if (letterSpacingPx) attrs.push(`letter-spacing="${n(letterSpacingPx)}"`)

  return `<text ${attrs.join(' ')}>${escapeXml(text)}</text>`
}

/**
 * Inline the QR as vector rather than a raster data-URI, so it stays sharp at
 * print resolution.
 *
 * The qrcode package emits a complete <svg viewBox="0 0 N N"> whose dark
 * modules are a STROKED path relying on the default stroke-width of 1. Both the
 * viewBox scale and that stroke-width have to be carried onto the wrapper group
 * or the code renders as a smear of hairlines.
 */
async function renderQrField(certificate, field, width, height) {
  if (!field.visible) return ''

  const url = getCertificateVerifyUrl(certificate.public_id)
  const svg = await QRCode.toString(url, {
    type: 'svg',
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' }
  })

  const viewBoxMatch = svg.match(/viewBox="0 0 (\d+(?:\.\d+)?) /)
  const modules = viewBoxMatch ? Number(viewBoxMatch[1]) : 33
  const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')

  const box = field.size * height
  const scale = box / modules
  const left = field.x * width - box / 2
  const top = field.y * height - box / 2

  return `<g transform="translate(${n(left)} ${n(top)}) scale(${n(scale)})" stroke-width="1" shape-rendering="crispEdges">${inner}</g>`
}

/**
 * The built-in design, used when no template resolves.
 *
 * Follows the Ledger Desk constraints the rest of the product obeys: flat
 * corners, hairline rules, no shadows, no gradients. Hierarchy comes from rule
 * weight and letter-spacing, never elevation.
 */
function builtInBackground(width, height, brandName) {
  const outer = 0.028 * height
  const inner = outer + 0.011 * height
  const panel = inner + 0.014 * height
  const cx = width / 2

  const frame = (inset, stroke, strokeWidth) =>
    `<rect x="${n(inset)}" y="${n(inset)}" width="${n(width - inset * 2)}" height="${n(height - inset * 2)}" ` +
    `fill="none" stroke="${stroke}" stroke-width="${n(strokeWidth)}"/>`

  const rule = (x1, x2, y, stroke, strokeWidth) =>
    `<line x1="${n(x1)}" y1="${n(y)}" x2="${n(x2)}" y2="${n(y)}" stroke="${stroke}" stroke-width="${n(strokeWidth)}"/>`

  return [
    `<rect width="${width}" height="${height}" fill="${PALETTE.paper}"/>`,
    `<rect x="${n(panel)}" y="${n(panel)}" width="${n(width - panel * 2)}" height="${n(height - panel * 2)}" fill="${PALETTE.panel}"/>`,

    // Watermark monogram, well under the text it sits behind.
    `<text x="${n(cx)}" y="${n(height * 0.66)}" font-family="${FONT_FAMILIES.display}" font-size="${n(height * 0.52)}" ` +
      `font-weight="700" fill="${PALETTE.gold}" fill-opacity="0.045" text-anchor="middle" ` +
      `transform="rotate(-18 ${n(cx)} ${n(height * 0.5)})">PF</text>`,

    // Double rule: a heavier gold frame with a hairline companion inside.
    frame(outer, PALETTE.gold, height * 0.0022),
    frame(inner, PALETTE.rule, height * 0.001),

    // Masthead.
    `<text x="${n(cx)}" y="${n(height * 0.145)}" font-family="${FONT_FAMILIES.mono}" font-size="${n(height * 0.026)}" ` +
      `font-weight="700" fill="${PALETTE.gold}" text-anchor="middle" letter-spacing="${n(height * 0.018)}">` +
      `${escapeXml(String(brandName || 'PROPFIRM').toUpperCase())}</text>`,
    rule(width * 0.42, width * 0.58, height * 0.175, PALETTE.rule, height * 0.0012),
    `<text x="${n(cx)}" y="${n(height * 0.245)}" font-family="${FONT_FAMILIES.mono}" font-size="${n(height * 0.0175)}" ` +
      `font-weight="400" fill="${PALETTE.muted}" text-anchor="middle" letter-spacing="${n(height * 0.012)}">` +
      `CERTIFICATE OF ACHIEVEMENT</text>`,

    // Flourish rules ABOVE the recipient name. They sat on the name's own
    // baseline band at 0.44 and struck straight through the glyphs.
    rule(width * 0.20, width * 0.36, height * 0.378, PALETTE.gold, height * 0.0014),
    rule(width * 0.64, width * 0.80, height * 0.378, PALETTE.gold, height * 0.0014),

    // Signatory block, kept clear of the certificate ID on the left and the QR
    // block on the right (which spans x 0.78-0.93 at the default layout).
    rule(width * 0.56, width * 0.75, height * 0.862, PALETTE.rule, height * 0.0014),
    `<text x="${n(width * 0.655)}" y="${n(height * 0.893)}" font-family="${FONT_FAMILIES.mono}" font-size="${n(height * 0.0125)}" ` +
      `font-weight="400" fill="${PALETTE.muted}" text-anchor="middle" letter-spacing="${n(height * 0.008)}">` +
      `AUTHORISED SIGNATORY</text>`
  ].join('')
}

function revokedOverprint(width, height) {
  const cx = width / 2
  const cy = height / 2
  return (
    `<g transform="rotate(-24 ${n(cx)} ${n(cy)})">` +
    `<rect x="${n(width * 0.08)}" y="${n(cy - height * 0.085)}" width="${n(width * 0.84)}" height="${n(height * 0.17)}" ` +
      `fill="${PALETTE.loss}" fill-opacity="0.12" stroke="${PALETTE.loss}" stroke-opacity="0.5" stroke-width="${n(height * 0.003)}"/>` +
    `<text x="${n(cx)}" y="${n(cy + height * 0.045)}" font-family="${FONT_FAMILIES.mono}" font-size="${n(height * 0.115)}" ` +
      `font-weight="700" fill="${PALETTE.loss}" fill-opacity="0.72" text-anchor="middle" ` +
      `letter-spacing="${n(height * 0.02)}">REVOKED</text>` +
    `</g>`
  )
}

function templateBackground(template, width, height) {
  const buffer = fs.readFileSync(resolveTemplateImagePath(template))
  const mime = template.image_path.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
  const href = `data:${mime};base64,${buffer.toString('base64')}`
  return `<image href="${href}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid slice"/>`
}

/**
 * Resolve a stored template path to disk, refusing anything that escapes the
 * uploads root. The stored value is admin-supplied and this read is unguarded
 * otherwise; a `../../etc/passwd` would happily base64 itself into a public
 * certificate.
 */
function resolveTemplateImagePath(template) {
  const uploadsRoot = path.resolve(__dirname, '..', 'uploads')
  const relative = String(template.image_path || '').replace(/^[/\\]+/, '')
  const absolute = path.resolve(uploadsRoot, relative)
  if (absolute !== uploadsRoot && !absolute.startsWith(uploadsRoot + path.sep)) {
    const error = new Error('Certificate template path escapes the uploads directory')
    error.code = 'CERTIFICATE_TEMPLATE_PATH_INVALID'
    throw error
  }
  return absolute
}

/**
 * Build the master SVG.
 *
 * @param {object} certificate  a certificates row (or a preview fixture)
 * @param {object|null} template  a certificate_templates row, or null for built-in
 * @param {{brandName?: string}} [options]
 */
async function buildCertificateSvg(certificate, template = null, options = {}) {
  const width = template ? Number(template.image_width) : BUILTIN_WIDTH
  const height = template ? Number(template.image_height) : BUILTIN_HEIGHT
  const layout = normalizeLayout(template ? template.layout : null)

  const background = template
    ? templateBackground(template, width, height)
    : builtInBackground(width, height, options.brandName)

  const parts = [background]
  for (const def of FIELD_DEFS) {
    const field = layout.fields[def.key]
    if (!field) continue
    parts.push(def.type === 'qr'
      ? await renderQrField(certificate, field, width, height)
      : renderTextField(certificate, def.key, field, width, height))
  }

  if (String(certificate.status || 'active') === 'revoked') {
    parts.push(revokedOverprint(width, height))
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}">${parts.join('')}</svg>`
  )
}

function resolveRenderWidth(requestedWidth, canvasWidth) {
  if (requestedWidth) {
    const requested = Number(requestedWidth)
    if (Number.isFinite(requested)) return Math.min(MAX_RENDER_WIDTH, Math.max(400, Math.round(requested)))
  }
  return Math.min(MAX_RENDER_WIDTH, Math.max(MIN_RENDER_WIDTH, canvasWidth))
}

async function renderCertificatePng(certificate, template = null, options = {}) {
  assertFontsAvailable()
  const svg = await buildCertificateSvg(certificate, template, options)
  const canvasWidth = template ? Number(template.image_width) : BUILTIN_WIDTH

  const resvg = new Resvg(svg, {
    font: resvgFontOptions(),
    fitTo: { mode: 'width', value: resolveRenderWidth(options.width, canvasWidth) }
  })
  return resvg.render().asPng()
}

/**
 * PDF wraps the rendered PNG rather than re-drawing the design in pdfkit
 * primitives. Two renderers would drift, and pdfkit cannot reproduce the
 * uploaded artwork anyway.
 */
async function renderCertificatePdf(certificate, template = null, options = {}) {
  const png = await renderCertificatePng(certificate, template, options)

  const canvasWidth = template ? Number(template.image_width) : BUILTIN_WIDTH
  const canvasHeight = template ? Number(template.image_height) : BUILTIN_HEIGHT

  // Page matches the certificate's aspect ratio, with the long edge at A4
  // landscape width, so it prints without letterboxing.
  const longEdge = 842
  const isLandscape = canvasWidth >= canvasHeight
  const pageWidth = isLandscape ? longEdge : longEdge * (canvasWidth / canvasHeight)
  const pageHeight = isLandscape ? longEdge * (canvasHeight / canvasWidth) : longEdge

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: [pageWidth, pageHeight], margin: 0 })
      doc.info.Title = `${certificate.title || 'Certificate'} — ${certificate.recipient_name || ''}`.trim()
      doc.info.Author = options.brandName || 'PropFirm'
      doc.info.Subject = `Certificate ${certificate.public_id}`

      const chunks = []
      doc.on('data', (chunk) => chunks.push(chunk))
      doc.on('end', () => resolve(Buffer.concat(chunks)))
      doc.on('error', reject)

      doc.image(png, 0, 0, { width: pageWidth, height: pageHeight })
      doc.end()
    } catch (error) {
      reject(error)
    }
  })
}

module.exports = {
  buildCertificateSvg,
  renderCertificatePng,
  renderCertificatePdf,
  resolveTemplateImagePath,
  assertFontsAvailable,
  BUILTIN_WIDTH,
  BUILTIN_HEIGHT,
  PALETTE
}
