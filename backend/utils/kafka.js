const { Kafka, logLevel } = require('kafkajs')
const logger = require('./logger')

let kafkaProducer = null
let kafkaInitPromise = null

function isKafkaConfigured() {
  return String(process.env.KAFKA_ENABLED || '').toLowerCase() === 'true' &&
    String(process.env.KAFKA_BROKERS || '').trim().length > 0
}

function getKafkaTopic(suffix) {
  const prefix = String(process.env.KAFKA_TOPIC_PREFIX || 'propfirm').trim().replace(/\.+$/, '')
  return `${prefix}.${suffix}`
}

async function initializeKafka() {
  if (kafkaProducer) return kafkaProducer
  if (!isKafkaConfigured()) {
    logger.info('[kafka] Kafka disabled; continuing without event streaming')
    return null
  }

  if (!kafkaInitPromise) {
    kafkaInitPromise = (async () => {
      try {
        const brokers = String(process.env.KAFKA_BROKERS || '')
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)

        const useSsl = String(process.env.KAFKA_SSL || '').toLowerCase() === 'true'
        const saslMechanism = String(process.env.KAFKA_SASL_MECHANISM || '').trim()
        const saslUsername = String(process.env.KAFKA_SASL_USERNAME || '').trim()
        const saslPassword = String(process.env.KAFKA_SASL_PASSWORD || '').trim()

        const kafka = new Kafka({
          clientId: process.env.KAFKA_CLIENT_ID || 'propfirm-backend',
          brokers,
          ssl: useSsl,
          sasl: saslMechanism && saslUsername && saslPassword ? {
            mechanism: saslMechanism,
            username: saslUsername,
            password: saslPassword
          } : undefined,
          logLevel: logLevel.NOTHING
        })

        kafkaProducer = kafka.producer()
        await kafkaProducer.connect()
        logger.info('[kafka] Producer connected', { brokers })
        return kafkaProducer
      } catch (error) {
        logger.error('[kafka] Failed to initialize producer', { error: error.message })
        kafkaProducer = null
        return null
      }
    })().finally(() => {
      kafkaInitPromise = null
    })
  }

  return kafkaInitPromise
}

async function publishDomainEvent(topicSuffix, payload, headers = {}) {
  const producer = kafkaProducer || await initializeKafka()
  if (!producer) return false

  try {
    const topic = getKafkaTopic(topicSuffix)
    const normalizedHeaders = Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, String(value)])
    )

    await producer.send({
      topic,
      messages: [{
        value: JSON.stringify({
          ...payload,
          emitted_at: new Date().toISOString()
        }),
        headers: normalizedHeaders
      }]
    })
    return true
  } catch (error) {
    logger.warn('[kafka] Failed to publish event', { error: error.message, topicSuffix })
    return false
  }
}

async function closeKafka() {
  if (!kafkaProducer) return
  try {
    await kafkaProducer.disconnect()
    logger.info('[kafka] Producer disconnected')
  } catch (error) {
    logger.warn('[kafka] Failed to disconnect producer cleanly', { error: error.message })
  } finally {
    kafkaProducer = null
  }
}

module.exports = {
  initializeKafka,
  publishDomainEvent,
  closeKafka,
  isKafkaConfigured
}
