const express = require('express')
const cors = require('cors')
const { createServer } = require('http')
const { Server } = require('socket.io')
const { fetchAndStorePrices, getCurrentPrices } = require('./priceFeed')
const authRoutes = require('./routes/auth')
const accountRoutes = require('./routes/accounts')
const tradeRoutes = require('./routes/trades')
const { runChallengeEngine } = require('./challengeEngine')
const adminRoutes = require('./routes/admin')
require('dotenv').config()

const app = express()
const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL,
    methods: ['GET', 'POST']
  }
})

app.use(cors({ origin: process.env.FRONTEND_URL }))
app.use(express.json())
app.use('/api/auth', authRoutes)
app.use('/api/accounts', accountRoutes)
app.use('/api/trades', tradeRoutes)
app.use('/api/admin', adminRoutes)

app.get('/', function(req, res) {
  res.json({
    message: 'Prop Firm API is running',
    status: 'OK',
    timestamp: new Date()
  })
})

app.get('/api/prices', async function(req, res) {
  try {
    const prices = await getCurrentPrices()
    res.json(prices)
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch prices' })
  }
})

io.on('connection', function(socket) {
  console.log('Trader connected:', socket.id)

  socket.on('join_account', function(userId) {
    socket.join(userId)
    console.log('User joined:', userId)
  })

  socket.on('disconnect', function() {
    console.log('Trader disconnected:', socket.id)
  })
})

app.set('io', io)

fetchAndStorePrices()
setInterval(fetchAndStorePrices, 10000)
runChallengeEngine()
setInterval(runChallengeEngine, 30000)


const PORT = process.env.PORT || 5000
httpServer.listen(PORT, function() {
  console.log('Server running on port ' + PORT)
})

module.exports = { app, io }
