const test = require('node:test')
const assert = require('node:assert/strict')
const adminRouter = require('../routes/admin')

test('kyc document presence predicate groups OR conditions before tenant scoping', () => {
  const predicate = adminRouter.__test__.buildKycDocumentPresencePredicate('u')

  assert.equal(
    predicate,
    '(u.id_document_path IS NOT NULL OR u.selfie_path IS NOT NULL)'
  )
  assert.match(predicate, /^\(.+\)$/)
})
