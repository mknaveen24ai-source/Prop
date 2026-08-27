const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
require('../loadEnv')

// scripts/rotate-encryption-keys.js re-implements the wire formats of
// utils/secureKycStorage.js and utils/totp.js, because both of those read their
// key from the environment (totp.js at module load) and so cannot hold an old
// and a new key open at the same time — which is the one thing a rotation needs.
//
// Duplicated crypto formats are exactly the kind of thing that drifts silently
// and is discovered during an incident, so these tests pin the copy to the
// original in the only way that counts: bytes written by one module must be
// readable by the other, in both directions.

const rotate = require('../scripts/rotate-encryption-keys')

// totp.js reads TOTP_ENCRYPTION_KEY at module load, so it must be set before
// the require below — not inside a test.
const TOTP_KEY_HEX = crypto.randomBytes(32).toString('hex')
process.env.TOTP_ENCRYPTION_KEY = TOTP_KEY_HEX
const totpModule = require('../utils/totp')

const KYC_SECRET = 'kyc-secret-for-tests'

test('KYC: rotation script decrypts what secureKycStorage wrote', () => {
  const previous = process.env.KYC_FILE_ENCRYPTION_KEY
  process.env.KYC_FILE_ENCRYPTION_KEY = KYC_SECRET

  // secureKycStorage encrypts a file in place, so this goes through a real one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-rot-'))
  const plainPath = path.join(dir, 'passport.pdf')
  const payload = crypto.randomBytes(2048)

  try {
    fs.writeFileSync(plainPath, payload)
    const storage = require('../utils/secureKycStorage')
    const encPath = storage.encryptFileAtRest(plainPath)

    const recovered = rotate.kycDecrypt(fs.readFileSync(encPath), rotate.kycKeyFrom(KYC_SECRET))
    assert.deepEqual(recovered, payload, 'script must read the production format')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.KYC_FILE_ENCRYPTION_KEY
    else process.env.KYC_FILE_ENCRYPTION_KEY = previous
  }
})

test('KYC: secureKycStorage reads what the rotation script wrote', () => {
  const previous = process.env.KYC_FILE_ENCRYPTION_KEY
  process.env.KYC_FILE_ENCRYPTION_KEY = KYC_SECRET

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kyc-rot-'))
  const encPath = path.join(dir, 'passport.pdf.enc')
  const payload = crypto.randomBytes(1024)

  try {
    fs.writeFileSync(encPath, rotate.kycEncrypt(payload, rotate.kycKeyFrom(KYC_SECRET)))

    const storage = require('../utils/secureKycStorage')
    const result = storage.readKycFileBuffer(encPath)
    assert.equal(result.encrypted, true)
    assert.deepEqual(result.buffer, payload, 'production code must read re-encrypted files')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.KYC_FILE_ENCRYPTION_KEY
    else process.env.KYC_FILE_ENCRYPTION_KEY = previous
  }
})

test('KYC: a wrong key fails loudly rather than returning garbage', () => {
  // This is the property the whole KYC audit rests on. GCM authenticates, so
  // "did this decrypt" is a trustworthy question and bucketing files by which
  // key opens them is sound.
  const payload = Buffer.from('identity document')
  const encrypted = rotate.kycEncrypt(payload, rotate.kycKeyFrom('the-old-key'))

  assert.throws(
    () => rotate.kycDecrypt(encrypted, rotate.kycKeyFrom('the-new-key')),
    /unable to authenticate|bad decrypt|unsupported state/i
  )
})

test('TOTP: rotation script and totp.js interoperate in both directions', () => {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' // 32-char base32, as speakeasy emits
  const key = rotate.totpKeyFrom(TOTP_KEY_HEX)

  assert.equal(rotate.totpDecrypt(totpModule.encryptSecret(secret), key), secret)
  assert.equal(totpModule.decryptSecret(rotate.totpEncrypt(secret, key)), secret)
})

test('TOTP: the base32 shape check is what rejects a bad decrypt', () => {
  // CBC is unauthenticated: a wrong key yields garbage or a padding error,
  // never a clean failure. The shape check is the only integrity signal
  // available, and it is what stops --apply from writing noise over real
  // enrolments.
  //
  // Proven deterministically by decrypting with the CORRECT key: padding is
  // valid and the plaintext is recovered exactly, so padding cannot be doing
  // the rejecting. Only the base32 check can. (Brute-forcing wrong keys would
  // test the same property, but a wrong key clears PKCS#7 padding only ~1/256
  // of the time, which makes the outcome a coin flip rather than a test.)
  const key = rotate.totpKeyFrom(crypto.randomBytes(32).toString('hex'))
  const notASecret = rotate.totpEncrypt('hello world!!', key)

  assert.throws(() => rotate.totpDecrypt(notASecret, key), /non-base32/)
})

test('TOTP: no wrong key is ever accepted as a valid secret', () => {
  const secret = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'
  const stored = rotate.totpEncrypt(secret, rotate.totpKeyFrom(crypto.randomBytes(32).toString('hex')))

  // Every rejection path is acceptable (padding error or shape); silently
  // returning a value is not. That is the property --apply depends on.
  for (let i = 0; i < 500; i++) {
    const wrong = rotate.totpKeyFrom(crypto.randomBytes(32).toString('hex'))
    assert.throws(() => rotate.totpDecrypt(stored, wrong))
  }
})

test('TOTP: the base32 pattern accepts real secrets and rejects prose', () => {
  assert.ok(rotate.BASE32_SECRET.test('JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP'))
  assert.ok(rotate.BASE32_SECRET.test('MFRGGZDFMZTWQ2LKNNWG23TP'))
  assert.ok(!rotate.BASE32_SECRET.test('hello world'), 'lowercase and spaces are not base32')
  assert.ok(!rotate.BASE32_SECRET.test('JBSW1809'), '0, 1 and 8 are not in the base32 alphabet')
  assert.ok(!rotate.BASE32_SECRET.test(''), 'empty is not a secret')
})
