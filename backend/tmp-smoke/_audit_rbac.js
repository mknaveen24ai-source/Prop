process.env.ADMIN_JWT_SECRET = 'x'.repeat(48)
process.env.JWT_SECRET = 'y'.repeat(48)
process.env.NODE_ENV = 'test'
const jwt = require('jsonwebtoken')
const { authenticateAdmin, BUILT_IN_ROLES } = require('../routes/middleware.js')
;(async () => {
  for (const role of BUILT_IN_ROLES) {
    const token = jwt.sign({ role, adminId: 1, atv: 1, email: 'a@b.c' }, process.env.ADMIN_JWT_SECRET, { expiresIn: '1h' })
    const req = { headers: { authorization: 'Bearer ' + token }, cookies: {} }
    let out = '(no response)'
    const res = { status: (c) => ({ json: (b) => { out = `HTTP ${c} — ${b.error}` } }) }
    await authenticateAdmin(req, res, () => { out = 'ALLOWED (next() called)' })
    console.log('  role=' + String(role).padEnd(16) + '-> ' + out)
  }
  process.exit(0)
})()
