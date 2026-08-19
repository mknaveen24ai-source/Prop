'use strict'

/**
 * The contract between the admin layout editor and the server renderer.
 *
 * Every position and size is a FRACTION of the canvas (x of width, y and size
 * of height), never a pixel. That is what lets one layout render correctly
 * against a 1600x1100 built-in design and a 4000x2800 uploaded template alike,
 * and it is why the editor can show the artwork at whatever width fits the
 * browser without the maths changing.
 *
 * Anchor semantics, which the editor must match exactly:
 *   - text fields: x is the anchor (left/centre/right per align), y is the
 *     BASELINE.
 *   - the QR block: (x, y) is its CENTRE.
 *
 * The font setting is an enum, not a free-text family. resvg can only use the
 * faces we ship in backend/assets/fonts, and an unknown family silently falls
 * back to the default rather than erroring, so a free-text box would be a
 * control that appears to work and does nothing.
 */

const FONT_FAMILIES = {
  display: 'Playfair Display',
  ui: 'Source Serif 4',
  mono: 'IBM Plex Mono'
}

// Only the weights we actually ship a static file for. A variable font ignores
// font-weight in resvg (verified: Playfair 400 and 700 rendered byte-identical
// from the variable file), so the shipped set is Regular + Bold per family.
const FONT_WEIGHTS = [400, 700]

const TEXT_ALIGNMENTS = ['left', 'center', 'right']

/**
 * Field catalogue, in editor display order. The sample values drive the
 * template preview render, so an admin can position fields against realistic
 * content before a single certificate exists.
 */
const FIELD_DEFS = [
  { key: 'recipient_name', label: 'Trader Name',       type: 'text', sample: 'Alexandra Whitmore' },
  { key: 'title',          label: 'Certificate Title', type: 'text', sample: '$100,000 Funded Trader' },
  { key: 'subtitle',       label: 'Subtitle',          type: 'text', sample: 'Evaluation completed with distinction' },
  { key: 'amount',         label: 'Amount',            type: 'text', sample: '$100,000.00' },
  { key: 'issue_date',     label: 'Issue Date',        type: 'text', sample: '18 August 2026' },
  { key: 'public_id',      label: 'Certificate ID',    type: 'text', sample: 'PF-2026-0A7C-4E19' },
  { key: 'signature',      label: 'Digital Signature', type: 'text', sample: 'A598 6539 51C4 23EB' },
  { key: 'qr',             label: 'Verification QR',   type: 'qr',   sample: null }
]

const FIELD_KEYS = FIELD_DEFS.map((f) => f.key)
const FIELD_TYPES = Object.fromEntries(FIELD_DEFS.map((f) => [f.key, f.type]))

const TEXT_FIELD_DEFAULTS = {
  x: 0.5,
  y: 0.5,
  size: 0.03,
  align: 'center',
  color: '#EDE9E0',
  font: 'display',
  weight: 400,
  uppercase: false,
  letterSpacing: 0,
  visible: true
}

const QR_FIELD_DEFAULTS = { x: 0.85, y: 0.8, size: 0.16, visible: true }

/**
 * The default placement, tuned against the built-in design. An uploaded
 * template starts from this so the admin is nudging a sane arrangement rather
 * than dragging eight fields out of the top-left corner.
 */
const DEFAULT_LAYOUT = {
  fields: {
    recipient_name: { x: 0.5,   y: 0.475, size: 0.072, align: 'center', color: '#EDE9E0', font: 'display', weight: 700, uppercase: false, letterSpacing: 0,    visible: true },
    title:          { x: 0.5,   y: 0.585, size: 0.040, align: 'center', color: '#E8B400', font: 'display', weight: 400, uppercase: false, letterSpacing: 0.01, visible: true },
    subtitle:       { x: 0.5,   y: 0.645, size: 0.020, align: 'center', color: '#8C8880', font: 'ui',      weight: 400, uppercase: false, letterSpacing: 0,    visible: false },
    amount:         { x: 0.5,   y: 0.700, size: 0.030, align: 'center', color: '#EDE9E0', font: 'mono',    weight: 700, uppercase: false, letterSpacing: 0,    visible: false },
    issue_date:     { x: 0.14,  y: 0.868, size: 0.017, align: 'left',   color: '#8C8880', font: 'mono',    weight: 400, uppercase: true,  letterSpacing: 0.02, visible: true },
    public_id:      { x: 0.14,  y: 0.906, size: 0.017, align: 'left',   color: '#E8B400', font: 'mono',    weight: 700, uppercase: true,  letterSpacing: 0.02, visible: true },
    signature:      { x: 0.5,   y: 0.945, size: 0.011, align: 'center', color: '#5C5852', font: 'mono',    weight: 400, uppercase: true,  letterSpacing: 0.008, visible: true },
    qr:             { x: 0.855, y: 0.855, size: 0.150, visible: true }
  }
}

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function normalizeColor(value, fallback) {
  const raw = String(value == null ? '' : value).trim()
  return /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : fallback
}

/**
 * Coerce any stored or submitted layout into a complete, safe one.
 *
 * Two jobs. First, defaulting: a layout saved before a new field existed must
 * not crash the renderer or leave the editor with an undefined field, so every
 * known key is always present afterwards. Second, sanitising: this data is
 * admin-supplied and goes straight into SVG attributes, so colours are
 * pattern-matched and enums checked against allow-lists rather than
 * interpolated as-is.
 *
 * Positions clamp to -0.25..1.25 rather than 0..1 because slightly outside the
 * canvas is a legitimate thing to want while nudging, and a field parked out of
 * frame is a visible mistake rather than a security problem.
 */
function normalizeLayout(layout) {
  const source = (layout && typeof layout === 'object' && layout.fields && typeof layout.fields === 'object')
    ? layout.fields
    : {}

  const fields = {}
  for (const def of FIELD_DEFS) {
    const incoming = (source[def.key] && typeof source[def.key] === 'object') ? source[def.key] : {}
    const fallback = DEFAULT_LAYOUT.fields[def.key]
      || (def.type === 'qr' ? QR_FIELD_DEFAULTS : TEXT_FIELD_DEFAULTS)

    if (def.type === 'qr') {
      fields[def.key] = {
        x: clamp(incoming.x, -0.25, 1.25, fallback.x),
        y: clamp(incoming.y, -0.25, 1.25, fallback.y),
        size: clamp(incoming.size, 0.02, 0.6, fallback.size),
        visible: incoming.visible === undefined ? fallback.visible : Boolean(incoming.visible)
      }
      continue
    }

    fields[def.key] = {
      x: clamp(incoming.x, -0.25, 1.25, fallback.x),
      y: clamp(incoming.y, -0.25, 1.25, fallback.y),
      size: clamp(incoming.size, 0.004, 0.3, fallback.size),
      align: TEXT_ALIGNMENTS.includes(incoming.align) ? incoming.align : fallback.align,
      color: normalizeColor(incoming.color, fallback.color),
      font: Object.prototype.hasOwnProperty.call(FONT_FAMILIES, incoming.font) ? incoming.font : fallback.font,
      weight: FONT_WEIGHTS.includes(Number(incoming.weight)) ? Number(incoming.weight) : fallback.weight,
      uppercase: incoming.uppercase === undefined ? fallback.uppercase : Boolean(incoming.uppercase),
      letterSpacing: clamp(incoming.letterSpacing, -0.05, 0.5, fallback.letterSpacing),
      visible: incoming.visible === undefined ? fallback.visible : Boolean(incoming.visible)
    }
  }

  return { fields }
}

module.exports = {
  FONT_FAMILIES,
  FONT_WEIGHTS,
  TEXT_ALIGNMENTS,
  FIELD_DEFS,
  FIELD_KEYS,
  FIELD_TYPES,
  DEFAULT_LAYOUT,
  normalizeLayout
}
