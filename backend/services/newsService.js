const axios = require('axios')
const pool = require('../db')
const logger = require('../utils/logger')

// ─────────────────────────────────────────────────────────────────────────────
// NewsService — ForexFactory calendar integration
//
// Fix: Polls every 30 minutes (was 4 hours), caches results in PostgreSQL,
// and flags events 15 minutes BEFORE they happen (was only ±3 min window).
// Covers all major currency pairs, not just USD.
// ─────────────────────────────────────────────────────────────────────────────
class NewsService {
  constructor() {
    this.events = []
    this.lastFetch = 0
    this.fetchIntervalMs = 30 * 60 * 1000 // 30 minutes
    this.calendarUrl = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
    this.dbReady = false
    this.fetchInProgress = false
    this.intervalHandle = null
  }

  async ensureTable() {
    if (this.dbReady) return
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS news_cache (
          id          BIGSERIAL PRIMARY KEY,
          title       TEXT NOT NULL,
          country     TEXT NOT NULL,
          impact      TEXT NOT NULL,
          event_time  TIMESTAMPTZ NOT NULL,
          fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (title, event_time)
        )
      `)
      await pool.query(
        `CREATE INDEX IF NOT EXISTS idx_news_cache_event_time ON news_cache(event_time ASC)`
      )
      this.dbReady = true
      logger.info('NewsService: news_cache table ready')
    } catch (err) {
      logger.warn('NewsService: Could not create news_cache table', { error: err.message })
    }
  }

  start() {
    if (this.intervalHandle) {
      logger.info('NewsService already running')
      return
    }

    this.ensureTable()
      .then(() => {
        this.fetchNews()
        this.intervalHandle = setInterval(() => this.fetchNews(), this.fetchIntervalMs)
      })
      .catch(err => logger.error('NewsService start error', { error: err.message }))

    logger.info('NewsService started — 30-min refresh cycle, 15-min pre-event protection window')
  }

  stop() {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    logger.info('NewsService stopped')
  }

  async fetchNews() {
    // Concurrency guard: prevent overlapping fetches
    if (this.fetchInProgress) return
    this.fetchInProgress = true

    try {
      const { data } = await axios.get(this.calendarUrl, { timeout: 12000 })

      if (!Array.isArray(data)) {
        logger.warn('NewsService: Expected array from ForexFactory, got:', typeof data)
        await this.loadFromCache()
        return
      }

      const now = Date.now()
      const validCountries = ['USD', 'EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'NZD']

      const parsed = data
        .filter(e => {
          if (!e || typeof e !== 'object') return false
          if (!e.date || !e.title || !e.country || !e.impact) return false
          if (isNaN(new Date(e.date).getTime())) return false
          if (!validCountries.includes(e.country)) return false
          // Only High impact — these are the events that move the market
          if (e.impact !== 'High') return false
          return true
        })
        .map(e => ({
          title:     String(e.title).slice(0, 200),
          country:   e.country,
          impact:    e.impact,
          dateStr:   e.date,
          timestamp: new Date(e.date).getTime()
        }))
        // Keep events from last 24 hours + all future events this week
        .filter(e => e.timestamp > now - (24 * 60 * 60 * 1000))
        .sort((a, b) => a.timestamp - b.timestamp)

      this.events = parsed
      this.lastFetch = now

      // ── Persist to DB cache ──────────────────────────────────────────────
      if (this.dbReady && parsed.length > 0) {
        for (const evt of parsed) {
          try {
            await pool.query(
              `INSERT INTO news_cache (title, country, impact, event_time, fetched_at)
               VALUES ($1, $2, $3, $4::timestamptz, NOW())
               ON CONFLICT (title, event_time)
               DO UPDATE SET fetched_at = NOW()`,
              [evt.title, evt.country, evt.impact, new Date(evt.timestamp).toISOString()]
            )
          } catch (_) {
            // Best-effort cache write — don't fail the whole fetch
          }
        }
        // Clean stale cache entries older than 8 days
        try {
          await pool.query(
            `DELETE FROM news_cache WHERE event_time < NOW() - INTERVAL '8 days'`
          )
        } catch (_) {}
      }

      logger.info(`NewsService: fetched ${parsed.length} High-impact events (${validCountries.join(',')} combined)`)
    } catch (err) {
      logger.error('NewsService: ForexFactory fetch failed, falling back to DB cache', { error: err.message })
      await this.loadFromCache()
    } finally {
      this.fetchInProgress = false
    }
  }

  async loadFromCache() {
    if (!this.dbReady) return
    try {
      const result = await pool.query(
        `SELECT title, country, impact, event_time
         FROM news_cache
         WHERE event_time > NOW() - INTERVAL '24 hours'
         ORDER BY event_time ASC`
      )
      const cached = result.rows.map(r => ({
        title:     r.title,
        country:   r.country,
        impact:    r.impact,
        dateStr:   r.event_time,
        timestamp: new Date(r.event_time).getTime()
      }))
      if (cached.length > 0) {
        this.events = cached
        logger.info(`NewsService: loaded ${cached.length} events from DB cache`)
      }
    } catch (err) {
      logger.warn('NewsService: DB cache fallback also failed', { error: err.message })
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // getActiveNewsEvent
  //
  // FIX: lookaheadMins is now 15 (was 3). Returns the active event if we are
  // within 15 minutes BEFORE OR 15 minutes AFTER the scheduled event time.
  // This gives traders a full 30-minute protection window around each event.
  // ──────────────────────────────────────────────────────────────────────────
  getActiveNewsEvent(lookaheadMins = 15) {
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

  // ──────────────────────────────────────────────────────────────────────────
  // getUpcomingEvents
  //
  // NEW: Returns all High-impact events scheduled in the next `minutes`
  // minutes. Used by the Economic Calendar widget on the trader dashboard.
  // ──────────────────────────────────────────────────────────────────────────
  getUpcomingEvents(minutes = 120) {
    const now = Date.now()
    const limitMs = minutes * 60 * 1000
    return this.events
      .filter(e => e.timestamp >= now && e.timestamp <= now + limitMs)
      .sort((a, b) => a.timestamp - b.timestamp)
  }

  // Returns ALL stored events (past 24h + future this week) for the admin panel
  getAllEvents() {
    return this.events
  }

  // Returns the timestamp of the last successful API fetch
  getLastFetchTime() {
    return this.lastFetch
  }
}

module.exports = new NewsService()
