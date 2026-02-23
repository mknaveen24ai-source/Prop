const axios = require('axios')
const pool = require('./db')
require('dotenv').config()

const INSTRUMENTS = {
  EURUSD: 'EUR/USD',
  GBPUSD: 'GBP/USD',
  XAUUSD: 'XAU/USD',
  XAGUSD: 'XAG/USD'
}

async function fetchAndStorePrices() {
  try {
    const symbols = Object.values(INSTRUMENTS).join(',')
    const response = await axios.get('https://api.twelvedata.com/price', {
      params: {
        symbol: symbols,
        apikey: process.env.TWELVEDATA_API_KEY
      }
    })
    const data = response.data
    for (const [dbSymbol, apiSymbol] of Object.entries(INSTRUMENTS)) {
      const priceData = data[apiSymbol]
      if (priceData && priceData.price) {
        const price = parseFloat(priceData.price)
        let spread = 0.00002
        if (dbSymbol.includes('XAU')) spread = 0.50
        if (dbSymbol.includes('XAG')) spread = 0.02
        const bid = price
        const ask = price + spread
        await pool.query(
          'INSERT INTO price_feed (instrument, bid, ask, updated_at) VALUES ($1, $2, $3, NOW()) ON CONFLICT (instrument) DO UPDATE SET bid = $2, ask = $3, updated_at = NOW()',
          [dbSymbol, bid, ask]
        )
      }
    }
    console.log('Prices updated:', new Date().toISOString())
  } catch (error) {
    console.error('Price feed error:', error.message)
  }
}

async function getCurrentPrices() {
  const result = await pool.query('SELECT * FROM price_feed')
  const prices = {}
  result.rows.forEach(function(row) {
    prices[row.instrument] = {
      bid: parseFloat(row.bid),
      ask: parseFloat(row.ask),
      updated_at: row.updated_at
    }
  })
  return prices
}

module.exports = { fetchAndStorePrices: fetchAndStorePrices, getCurrentPrices: getCurrentPrices }
