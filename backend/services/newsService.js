const axios = require('axios')
const logger = require('../utils/logger')

class NewsService {
  constructor() {
    this.events = []
    this.lastFetch = 0
    this.fetchIntervalMs = 4 * 60 * 60 * 1000 // 4 hours
    this.calendarUrl = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
  }

  start() {
    this.fetchNews()
    setInterval(() => this.fetchNews(), this.fetchIntervalMs)
    logger.info('NewsService started: watching for USD High impact events')
  }

  async fetchNews() {
    try {
      const { data } = await axios.get(this.calendarUrl, { timeout: 10000 })
      
      // FIX (MEDIUM #20): Add schema validation to prevent unexpected behavior
      // from malformed or malicious third-party API responses.
      if (!Array.isArray(data)) {
        logger.warn('NewsService: Invalid response format, expected array')
        return
      }

      const now = Date.now()
      const validCountries = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD']
      const validImpacts = ['High', 'Medium', 'Low']
      
      this.events = data
        .filter(e => {
          // Validate required fields exist and have expected values
          if (!e || typeof e !== 'object') return false
          if (!e.date || !e.title || !e.country || !e.impact) return false
          if (isNaN(new Date(e.date).getTime())) return false // Invalid date
          if (!validCountries.includes(e.country)) return false
          if (!validImpacts.includes(e.impact)) return false
          return true
        })
        .filter(e => e.country === 'USD' && e.impact === 'High')
        .map(e => ({
          title: String(e.title).slice(0, 200), // Limit length
          country: e.country,
          impact: e.impact,
          dateStr: e.date,
          timestamp: new Date(e.date).getTime()
        }))
        .filter(e => e.timestamp > now - (24 * 60 * 60 * 1000)) // Keep recent past too

      this.lastFetch = now
      logger.info(`NewsService fetched ${this.events.length} upcoming USD High impact events`)
    } catch (err) {
      logger.error('NewsService failed to fetch calendar', { error: err.message })
    }
  }

  /**
   * Returns active news event if current time is within +/- lookaheadMins of the event.
   */
  getActiveNewsEvent(lookaheadMins = 3) {
    if (!this.events.length) return null

    const now = Date.now()
    const windowMs = lookaheadMins * 60 * 1000

    for (const evt of this.events) {
      if (now >= evt.timestamp - windowMs && now <= evt.timestamp + windowMs) {
        return evt
      }
    }
    return null
  }
}

module.exports = new NewsService()
