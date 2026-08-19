process.env.JWT_SECRET = process.env.JWT_SECRET || 'local-dev-secret-for-render-fixture'
process.env.FRONTEND_URL = process.env.FRONTEND_URL || 'https://propfirm.example.com'

const fs = require('fs')
const path = require('path')
const { signCertificate } = require('../../utils/certificateSignature')
const { renderCertificatePng, renderCertificatePdf, buildCertificateSvg } = require('../../services/certificateRenderer')

const OUT = process.argv[2] || path.resolve(__dirname, 'out')
fs.mkdirSync(OUT, { recursive: true })

function fixture(overrides = {}) {
  const cert = {
    public_id: 'PF-2026-0A7C-4E19',
    user_id: '11111111-2222-3333-4444-555555555555',
    kind: 'funded',
    title: '$100,000 Funded Trader',
    subtitle: 'Evaluation completed with distinction',
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

async function main() {
  const cases = [
    ['builtin-funded', fixture()],
    ['builtin-payout', fixture({ kind: 'payout', title: '$4,500 Profit Payout', amount: 4500, recipient_name: 'Sam Okafor' })],
    ['builtin-phase1', fixture({ kind: 'phase_passed', title: 'Phase 1 Challenge — $50,000', amount: 50000, recipient_name: 'Wei Zhang' })],
    ['builtin-revoked', fixture({ status: 'revoked' })],
    ['builtin-longname', fixture({ recipient_name: 'Bartholomew Fitzwilliam-Montgomery III', title: 'Phase 2 Challenge — $200,000' })],
    ['builtin-xss', fixture({ recipient_name: '<script>alert(1)</script> & "friends"' })]
  ]

  for (const [name, cert] of cases) {
    const png = await renderCertificatePng(cert, null)
    fs.writeFileSync(path.join(OUT, `${name}.png`), png)
    console.log(`${name.padEnd(20)} png ${String(png.length).padStart(8)} bytes`)
  }

  const cert = fixture()
  const svg = await buildCertificateSvg(cert, null)
  fs.writeFileSync(path.join(OUT, 'builtin-funded.svg'), svg)
  const pdf = await renderCertificatePdf(cert, null)
  fs.writeFileSync(path.join(OUT, 'builtin-funded.pdf'), pdf)
  console.log(`${'svg'.padEnd(20)}     ${String(svg.length).padStart(8)} bytes`)
  console.log(`${'pdf'.padEnd(20)}     ${String(pdf.length).padStart(8)} bytes`)

  // Escaping must survive into the SVG as entities, never as live markup.
  const hostile = await buildCertificateSvg(fixture({ recipient_name: '<script>alert(1)</script>' }), null)
  console.log('xss escaped         :', !hostile.includes('<script>'))
  console.log('qr url present      :', svg.includes('crispEdges'))
  console.log('small preview width :', (await renderCertificatePng(cert, null, { width: 600 })).length, 'bytes')
}

main().catch((error) => { console.error(error); process.exit(1) })
