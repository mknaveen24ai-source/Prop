import assert from 'node:assert/strict'
import test from 'node:test'
import router = require('../routes/admin/kycDocuments')

void test('KYC document types preserve the existing database-column mapping', () => {
  assert.equal(router.__test__.documentColumnForType('selfie'), 'selfie_path')
  assert.equal(router.__test__.documentColumnForType('id_back'), 'id_document_back_path')
  assert.equal(router.__test__.documentColumnForType('id'), 'id_document_path')
  assert.equal(router.__test__.documentColumnForType('legacy-or-unknown'), 'id_document_path')
})

void test('KYC route parameters start unknown and require string path segments', () => {
  assert.deepEqual(router.__test__.parseKycDocumentParams({ userId: 'user-1', type: 'selfie' }), {
    userId: 'user-1',
    type: 'selfie'
  })
  assert.equal(router.__test__.parseKycDocumentParams({ userId: 1, type: 'selfie' }), null)
  assert.equal(router.__test__.parseKycDocumentParams(null), null)
})
