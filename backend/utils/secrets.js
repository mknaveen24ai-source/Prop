/**
 * Secrets Management Utility
 * 
 * Provides a centralized way to manage sensitive configuration values.
 * Supports both local development (.env) and production (AWS Secrets Manager, etc.)
 * 
 * NEVER:
 * - Log secrets
 * - Commit secrets to git
 * - Pass secrets in URLs or query strings
 * - Embed secrets in code
 */

const logger = require('./logger')

// ─────────────────────────────────────────────────────────────────────────
// Secret Keys Registry
// List all sensitive values that should be managed securely
// ─────────────────────────────────────────────────────────────────────────
const SECRET_KEYS = [
  'JWT_SECRET',           // User JWT signing key
  'ADMIN_JWT_SECRET',     // Admin JWT signing key
  'DATABASE_URL',         // PostgreSQL connection string
  'REDIS_URL',            // Redis connection string
  'TWILIO_AUTH_TOKEN',    // Twilio SMS API (if used)
  'SENDGRID_API_KEY',     // SendGrid email API (if used)
  'STRIPE_SECRET_KEY',    // Stripe payment API (if used)
  'ADMIN_PASSWORD_BACKUP', // Backup admin password (if set)
  'ENCRYPTION_KEY'        // Data encryption key (if used)
]

// ─────────────────────────────────────────────────────────────────────────
// Load Secrets
// In development: load from .env
// In production: load from AWS Secrets Manager, HashiCorp Vault, etc.
// ─────────────────────────────────────────────────────────────────────────
let secrets = {}
let loadSecretsPromise = null

/**
 * Load secrets from appropriate store
 */
async function loadSecrets() {
  const env = process.env.NODE_ENV || 'development'
  const isProd = env === 'production'

  if (isProd && process.env.SECRETS_BACKEND === 'aws') {
    // Production: AWS Secrets Manager (async, but we load at startup)
    await loadSecretsFromAWS()
  } else if (isProd && process.env.SECRETS_BACKEND === 'vault') {
    // Production: HashiCorp Vault
    await loadSecretsFromVault()
  } else {
    // Development: Use environment variables (from .env file)
    loadSecretsFromEnv()
  }

  // Validate all required secrets are present
  validateSecrets()
}

function ensureSecretsLoaded() {
  if (!loadSecretsPromise) {
    loadSecretsPromise = loadSecrets().catch((err) => {
      loadSecretsPromise = null
      throw err
    })
  }
  return loadSecretsPromise
}

/**
 * Load from environment variables (development)
 */
function loadSecretsFromEnv() {
  for (const key of SECRET_KEYS) {
    secrets[key] = process.env[key]
    
    // Log masking: only show first 10 chars in logs
    if (secrets[key]) {
      const masked = secrets[key].substring(0, 10) + '...'
      logger.debug(`[SECRETS] Loaded ${key} (${masked})`)
    }
  }
}

/**
 * Load from AWS Secrets Manager (production)
 * You MUST set AWS_REGION and AWS credentials
 */
async function loadSecretsFromAWS() {
  try {
    const AWS = require('aws-sdk')
    const region = process.env.AWS_REGION || 'us-east-1'
    const client = new AWS.SecretsManager({ region })

    // Load all secrets in parallel
    const loadPromises = SECRET_KEYS.map(async (key) => {
      try {
        const data = await client.getSecretValue({ SecretId: key }).promise()
        secrets[key] = data.SecretString
        logger.info(`[SECRETS] Loaded ${key} from AWS Secrets Manager`)
      } catch (err) {
        if (err.code === 'ResourceNotFoundException') {
          logger.warn(`[SECRETS] Secret ${key} not found in AWS Secrets Manager`)
        } else {
          logger.error(`[SECRETS] Failed to load ${key} from AWS:`, { error: err.message })
        }
      }
    })

    await Promise.all(loadPromises)
  } catch (err) {
    logger.error('[SECRETS] Failed to initialize AWS Secrets Manager:', { error: err.message })
    throw err
  }
}

/**
 * Load from HashiCorp Vault (production)
 * You MUST set VAULT_ADDR and VAULT_TOKEN
 */
async function loadSecretsFromVault() {
  try {
    const vault = require('node-vault')
    const client = vault({
      endpoint: process.env.VAULT_ADDR || 'http://localhost:8200',
      token: process.env.VAULT_TOKEN
    })

    const path = process.env.VAULT_PATH || 'secret/data/propfirm'
    const data = await client.read(path)

    for (const key of SECRET_KEYS) {
      secrets[key] = data.data.data[key]
    }

    logger.info('[SECRETS] Loaded all secrets from HashiCorp Vault')
  } catch (err) {
    logger.error('[SECRETS] Failed to load from Vault:', { error: err.message })
    throw err
  }
}

/**
 * Validate that all required secrets are present
 */
function validateSecrets() {
  const missing = []

  for (const key of SECRET_KEYS) {
    if (!secrets[key]) {
      // Some secrets are optional (e.g., SENDGRID_API_KEY)
      if (['TWILIO_AUTH_TOKEN', 'SENDGRID_API_KEY', 'STRIPE_SECRET_KEY'].includes(key)) {
        logger.warn(`[SECRETS] Optional secret not set: ${key}`)
      } else {
        missing.push(key)
      }
    }
  }

  if (missing.length > 0) {
    logger.error(`[SECRETS] CRITICAL: Missing required secrets: ${missing.join(', ')}`)
    logger.error('[SECRETS] Set in .env file for development, or config secrets backend for production')
    throw new Error(`Missing required secrets: ${missing.join(', ')}`)
  }

  logger.info(`[SECRETS] ✓ All ${Object.keys(secrets).length} required secrets loaded`)
}

/**
 * Get a secret value (with safety checks)
 */
function getSecret(key, defaultValue = undefined) {
  const value = secrets[key]

  if (!value && defaultValue === undefined) {
    logger.error(`[SECRETS] Attempted to get unknown secret: ${key}`)
    throw new Error(`Secret not found: ${key}`)
  }

  return value || defaultValue
}

/**
 * Check if a secret exists
 */
function hasSecret(key) {
  return !!secrets[key]
}

/**
 * Reload secrets (for config changes without restart)
 * Only works with certain backends (not recommended in production)
 */
async function reloadSecrets() {
  logger.warn('[SECRETS] Reloading secrets (not recommended in production)')
  secrets = {}
  loadSecretsPromise = null
  await ensureSecretsLoaded()
}

/**
 * Audit: Get list of loaded secrets (without values)
 */
function getLoadedSecretsInfo() {
  return Object.keys(secrets).map(key => ({
    key,
    loaded: !!secrets[key],
    length: secrets[key] ? secrets[key].length : 0
  }))
}

// Load secrets on module initialization
ensureSecretsLoaded().catch((err) => {
  logger.error('[SECRETS] Initial load failed:', { error: err.message })
})

module.exports = {
  ensureSecretsLoaded,
  getSecret,
  hasSecret,
  reloadSecrets,
  getLoadedSecretsInfo,
  SECRET_KEYS
}
