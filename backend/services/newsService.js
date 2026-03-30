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
      const { data } = await axios.get(this.calendarUrl)
      if (!Array.isArray(data)) return

      const now = Date.now()
      this.events = data
        .filter(e => e.country === 'USD' && e.impact === 'High')
        .map(e => ({
          title: e.title,
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
