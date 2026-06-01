'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const ENCRYPTION_MAGIC = Buffer.from('KYCENC1\0')
const IV_LENGTH = 12
const TAG_LENGTH = 16

function getEncryptionKey() {
  const secret = process.env.KYC_FILE_ENCRYPTION_KEY
    || (process.env.NODE_ENV === 'production' ? '' : (process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET))

  if (!secret) {
    const error = new Error('KYC file encryption key is not configured')
    error.code = 'KYC_ENCRYPTION_NOT_CONFIGURED'
    throw error
  }

  return crypto.createHash('sha256').update(String(secret)).digest()
}

function encryptFileAtRest(absolutePath) {
  const plaintext = fs.readFileSync(absolutePath)
  const iv = crypto.randomBytes(IV_LENGTH)
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const encryptedPath = `${absolutePath}.enc`

  fs.writeFileSync(encryptedPath, Buffer.concat([ENCRYPTION_MAGIC, iv, tag, ciphertext]), { mode: 0o600 })
  fs.unlinkSync(absolutePath)
  return encryptedPath
}

function isEncryptedKycFile(filePath) {
  return String(filePath || '').toLowerCase().endsWith('.enc')
}

function getOriginalKycExtension(filePath) {
  const normalized = String(filePath || '')
  const withoutEncryptedSuffix = isEncryptedKycFile(normalized)
    ? normalized.slice(0, -'.enc'.length)
    : normalized
  return path.extname(withoutEncryptedSuffix).toLowerCase()
}

function getKycContentType(filePath) {
  const ext = getOriginalKycExtension(filePath)
  if (ext === '.pdf') return 'application/pdf'
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  return 'application/octet-stream'
}

function readKycFileBuffer(absolutePath) {
  const fileBuffer = fs.readFileSync(absolutePath)
  if (!isEncryptedKycFile(absolutePath)) {
    return { buffer: fileBuffer, encrypted: false }
  }

  if (!fileBuffer.subarray(0, ENCRYPTION_MAGIC.length).equals(ENCRYPTION_MAGIC)) {
    const error = new Error('Invalid encrypted KYC file header')
    error.code = 'KYC_FILE_DECRYPT_FAILED'
    throw error
  }

  const ivStart = ENCRYPTION_MAGIC.length
  const tagStart = ivStart + IV_LENGTH
  const cipherStart = tagStart + TAG_LENGTH
  const iv = fileBuffer.subarray(ivStart, tagStart)
  const tag = fileBuffer.subarray(tagStart, cipherStart)
  const ciphertext = fileBuffer.subarray(cipherStart)
  const decipher = crypto.createDecipheriv('aes-256-gcm', getEncryptionKey(), iv)
  decipher.setAuthTag(tag)

  return {
    buffer: Buffer.concat([decipher.update(ciphertext), decipher.final()]),
    encrypted: true
  }
}

module.exports = {
  encryptFileAtRest,
  getKycContentType,
  getOriginalKycExtension,
  isEncryptedKycFile,
  readKycFileBuffer
}
