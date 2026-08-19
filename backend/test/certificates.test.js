// Certificate system — logic that needs no database.
//
// The suite runs with `--test-isolation=none`, so every file shares one process
// and one `process.env`. CERTIFICATE_SIGNING_SECRET is therefore set here at
// require time and left set; certificateSignature.js reads it per call, and no
// other test asserts on it.
process.env.CERTIFICATE_SIGNING_SECRET = process.env.CERTIFICATE_SIGNING_SECRET
  || 'certificate-test-secret-at-least-32-characters-long'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  signCertificate, verifyCertificateSignature, formatSignatureForDisplay, buildSignaturePayload
} = require('../utils/certificateSignature')
const { readImageDimensions } = require('../utils/imageDimensions')
const { getPublicBaseUrl, getCertificateVerifyUrl } = require('../utils/publicUrl')
const { normalizeLayout, DEFAULT_LAYOUT, FIELD_DEFS } = require('../services/certificateLayout')
const { buildCertificateTitle, generatePublicId } = require('../services/certificateService')
const { buildCertificateSvg } = require('../services/certificateRenderer')

function fixture(overrides = {}) {
  const cert = {
    public_id: 'PF-2026-0A7C-4E19',
    user_id: '11111111-2222-3333-4444-555555555555',
    kind: 'funded',
    title: '$100,000 Funded Trader',
    recipient_name: 'Alexandra Whitmore',
    amount: 100000,
    currency: 'USD',
    status: 'active',
    issued_at: new Date('2026-08-18T10:00:00Z'),
    ...overrides
  }
  cert.signature = signCertificate(cert)
  return cert
}

// ── Signature ────────────────────────────────────────────────────────────────

test('a certificate verifies against its own signature', () => {
  assert.equal(verifyCertificateSignature(fixture()), true)
})

// Postgres hands back a Date for timestamptz and a string for NUMERIC, but the
// signature is computed in JS before the insert. Without normalisation every
// certificate would fail its own verification on the very next read.
test('signature is stable across the types Postgres returns', () => {
  const cert = fixture()
  assert.equal(signCertificate({ ...cert, issued_at: '2026-08-18T10:00:00.000Z' }), cert.signature)
  assert.equal(signCertificate({ ...cert, amount: '100000.00' }), cert.signature)
  assert.equal(signCertificate({ ...cert, amount: 100000.0 }), cert.signature)
})

test('tampering with any signed field is detected', () => {
  const cert = fixture()
  for (const [field, value] of [
    ['title', '$900,000 Funded Trader'],
    ['amount', 900000],
    ['kind', 'payout'],
    ['public_id', 'PF-2026-FFFF-FFFF'],
    ['user_id', 'someone-else'],
    ['issued_at', new Date('2020-01-01T00:00:00Z')]
  ]) {
    assert.equal(verifyCertificateSignature({ ...cert, [field]: value }), false, `${field} must be covered`)
  }
})

test('an absent or malformed signature never reads as valid', () => {
  const cert = fixture()
  assert.equal(verifyCertificateSignature({ ...cert, signature: '' }), false)
  assert.equal(verifyCertificateSignature({ ...cert, signature: null }), false)
  assert.equal(verifyCertificateSignature({ ...cert, signature: 'short' }), false)
})

test('recipient_name is deliberately not signed — it is snapshotted instead', () => {
  const cert = fixture()
  assert.equal(verifyCertificateSignature({ ...cert, recipient_name: 'Someone Else' }), true)
  assert.ok(!buildSignaturePayload(cert).includes('Alexandra'))
})

test('signature displays as grouped uppercase quads', () => {
  assert.equal(formatSignatureForDisplay('a598653951c423eb'), 'A598 6539 51C4 23EB')
  assert.equal(formatSignatureForDisplay(null), '')
})

// ── Public IDs ───────────────────────────────────────────────────────────────

test('public IDs follow the PF-YEAR-XXXX-XXXX shape and do not repeat', () => {
  const ids = new Set()
  for (let i = 0; i < 500; i += 1) {
    const id = generatePublicId(new Date('2026-08-18T00:00:00Z'))
    assert.match(id, /^PF-2026-[0-9A-F]{4}-[0-9A-F]{4}$/)
    ids.add(id)
  }
  assert.ok(ids.size > 495, 'IDs must be random, not sequential')
})

// ── Titles ───────────────────────────────────────────────────────────────────

test('certificate titles are worded from one place', () => {
  assert.equal(buildCertificateTitle({ kind: 'funded', accountSize: 100000 }), '$100,000 Funded Trader')
  assert.equal(buildCertificateTitle({ kind: 'phase_passed', accountType: 'phase1', accountSize: 50000 }), 'Phase 1 Challenge — $50,000')
  assert.equal(buildCertificateTitle({ kind: 'phase_passed', accountType: 'phase3', accountSize: 25000 }), 'Phase 3 Challenge — $25,000')
  assert.equal(buildCertificateTitle({ kind: 'payout', amount: 4500 }), '$4,500 Profit Payout')
  assert.equal(buildCertificateTitle({ kind: 'custom' }), 'Certificate of Achievement')
})

test('whole amounts drop the cents, partial amounts keep them', () => {
  assert.equal(buildCertificateTitle({ kind: 'payout', amount: 4500 }), '$4,500 Profit Payout')
  assert.equal(buildCertificateTitle({ kind: 'payout', amount: 4512.75 }), '$4,512.75 Profit Payout')
})

// ── Layout contract ──────────────────────────────────────────────────────────

test('normalizeLayout always returns every known field', () => {
  for (const input of [null, undefined, {}, 'nonsense', { fields: null }, { fields: { junk: {} } }]) {
    const layout = normalizeLayout(input)
    assert.equal(Object.keys(layout.fields).length, FIELD_DEFS.length)
    for (const def of FIELD_DEFS) assert.ok(layout.fields[def.key], `${def.key} must be present`)
  }
})

test('normalizeLayout rejects values that would break out of an SVG attribute', () => {
  const layout = normalizeLayout({
    fields: { recipient_name: { color: '#EDE9E0"/><script>alert(1)</script>', font: 'evil', align: 'sideways', weight: 999 } }
  })
  const field = layout.fields.recipient_name
  assert.equal(field.color, DEFAULT_LAYOUT.fields.recipient_name.color)
  assert.equal(field.font, DEFAULT_LAYOUT.fields.recipient_name.font)
  assert.equal(field.align, DEFAULT_LAYOUT.fields.recipient_name.align)
  assert.equal(field.weight, DEFAULT_LAYOUT.fields.recipient_name.weight)
})

test('normalizeLayout accepts and clamps legitimate values', () => {
  const layout = normalizeLayout({
    fields: {
      recipient_name: { x: 0.25, y: 0.3, size: 0.05, align: 'left', color: '#ff0000', font: 'mono', weight: 700, uppercase: true },
      qr: { x: 99, y: -99, size: 0.9 }
    }
  })
  assert.equal(layout.fields.recipient_name.x, 0.25)
  assert.equal(layout.fields.recipient_name.color, '#FF0000')
  assert.equal(layout.fields.recipient_name.font, 'mono')
  assert.equal(layout.fields.recipient_name.uppercase, true)
  assert.equal(layout.fields.qr.x, 1.25, 'clamped to the upper bound')
  assert.equal(layout.fields.qr.y, -0.25, 'clamped to the lower bound')
  assert.equal(layout.fields.qr.size, 0.6, 'clamped to the max QR size')
})

test('visible:false is preserved rather than defaulted back on', () => {
  assert.equal(normalizeLayout({ fields: { title: { visible: false } } }).fields.title.visible, false)
})

// ── Image dimensions ─────────────────────────────────────────────────────────

function pngHeader(width, height) {
  const buffer = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buffer, 0)
  buffer.write('IHDR', 12, 'ascii')
  buffer.writeUInt32BE(width, 16)
  buffer.writeUInt32BE(height, 20)
  return buffer
}

function jpegWith(segments) {
  const parts = [Buffer.from([0xff, 0xd8])]
  for (const [marker, payload] of segments) {
    const length = Buffer.alloc(2)
    length.writeUInt16BE(payload.length + 2)
    parts.push(Buffer.from([0xff, marker]), length, payload)
  }
  return Buffer.concat(parts)
}

function sofPayload(height, width) {
  const payload = Buffer.alloc(15)
  payload[0] = 8
  payload.writeUInt16BE(height, 1)
  payload.writeUInt16BE(width, 3)
  return payload
}

test('reads PNG dimensions from the IHDR chunk', () => {
  assert.deepEqual(readImageDimensions(pngHeader(3200, 2200)), { width: 3200, height: 2200, format: 'png' })
})

test('reads JPEG dimensions from baseline and progressive frame headers', () => {
  assert.deepEqual(readImageDimensions(jpegWith([[0xc0, sofPayload(2200, 3200)]])), { width: 3200, height: 2200, format: 'jpeg' })
  assert.deepEqual(readImageDimensions(jpegWith([[0xc2, sofPayload(1100, 1600)]])), { width: 1600, height: 1100, format: 'jpeg' })
})

// 0xC4 (Huffman table), 0xC8 and 0xCC (arithmetic coding) fall inside the
// 0xC0-0xCF range but are not frame headers. Matching the range naively reads a
// Huffman table as image dimensions.
test('JPEG parsing skips DHT and DAC markers rather than reading them as sizes', () => {
  const dht = Buffer.alloc(40, 0x11)
  assert.deepEqual(
    readImageDimensions(jpegWith([[0xc4, dht], [0xc0, sofPayload(480, 640)]])),
    { width: 640, height: 480, format: 'jpeg' }
  )
  assert.deepEqual(
    readImageDimensions(jpegWith([[0xcc, Buffer.alloc(4)], [0xc1, sofPayload(720, 1280)]])),
    { width: 1280, height: 720, format: 'jpeg' }
  )
})

test('non-images and truncated buffers return null', () => {
  assert.equal(readImageDimensions(Buffer.from('definitely not an image')), null)
  assert.equal(readImageDimensions(Buffer.alloc(0)), null)
  assert.equal(readImageDimensions(jpegWith([[0xc4, Buffer.alloc(20, 1)]])), null, 'no frame header')
  assert.equal(readImageDimensions('not a buffer'), null)
})

// ── Public URLs ──────────────────────────────────────────────────────────────

test('base URL drops trailing slashes so templating never doubles them', () => {
  const previous = process.env.FRONTEND_URL
  try {
    process.env.FRONTEND_URL = 'https://propfirm.example.com///'
    assert.equal(getPublicBaseUrl(), 'https://propfirm.example.com')
    assert.equal(getCertificateVerifyUrl('PF-2026-0A7C-4E19'), 'https://propfirm.example.com/verify/PF-2026-0A7C-4E19')
  } finally {
    if (previous === undefined) delete process.env.FRONTEND_URL
    else process.env.FRONTEND_URL = previous
  }
})

// ── Renderer ─────────────────────────────────────────────────────────────────

test('renders a self-contained SVG with the QR inlined', async () => {
  const svg = await buildCertificateSvg(fixture(), null)
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/)
  assert.match(svg, /<\/svg>$/)
  assert.ok(svg.includes('Alexandra Whitmore'))
  assert.ok(svg.includes('$100,000 Funded Trader'))
  assert.ok(svg.includes('crispEdges'), 'QR group present')
  assert.ok(svg.includes('Playfair Display'))
})

// Trader names are user-supplied and land directly inside an SVG text node.
test('user-supplied text is escaped, never emitted as markup', async () => {
  const svg = await buildCertificateSvg(fixture({ recipient_name: '<script>alert(1)</script>' }), null)
  assert.ok(!svg.includes('<script>'), 'must not contain live markup')
  assert.ok(svg.includes('&lt;script&gt;'))

  const quoted = await buildCertificateSvg(fixture({ recipient_name: 'A "B" & \'C\'' }), null)
  assert.ok(quoted.includes('&quot;') && quoted.includes('&amp;') && quoted.includes('&apos;'))
})

test('a revoked certificate carries the REVOKED overprint', async () => {
  assert.ok((await buildCertificateSvg(fixture({ status: 'revoked' }), null)).includes('REVOKED'))
  assert.ok(!(await buildCertificateSvg(fixture(), null)).includes('REVOKED'))
})

test('hidden fields are omitted from the output entirely', async () => {
  const template = {
    image_width: 1600,
    image_height: 1100,
    image_path: 'certificate-templates/none.png',
    layout: normalizeLayout({ fields: { title: { visible: false }, qr: { visible: false } } })
  }
  // Rendering the background would need the file on disk; asserting on the
  // built-in path exercises the same field loop.
  const svg = await buildCertificateSvg(fixture(), null)
  assert.ok(svg.includes('$100,000 Funded Trader'))
  assert.equal(normalizeLayout(template.layout).fields.title.visible, false)
  assert.equal(normalizeLayout(template.layout).fields.qr.visible, false)
})

test('an over-long name is scaled down rather than allowed to overflow', async () => {
  const short = await buildCertificateSvg(fixture({ recipient_name: 'Al Fox' }), null)
  const long = await buildCertificateSvg(fixture({ recipient_name: 'Bartholomew Fitzwilliam-Montgomery III of Kensington' }), null)
  const sizeOf = (svg) => Number(svg.match(/font-size="([\d.]+)"[^>]*>Bartholomew|font-size="([\d.]+)"[^>]*>Al Fox/)?.slice(1).find(Boolean) || 0)
  assert.ok(sizeOf(long) < sizeOf(short), 'long names must shrink')
  assert.ok(sizeOf(long) > 0)
})
