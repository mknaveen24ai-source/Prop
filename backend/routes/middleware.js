const jwt = require('jsonwebtoken')
require('dotenv').config()

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ error: 'Access denied. No token provided.' })
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET)
    req.user = decoded
    next()
  } catch (error) {
    return res.status(403).json({ error: 'Invalid or expired token' })
  }
}

function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization']
  const token = authHeader && authHeader.split(' ')[1]

  if (!token) {
    return res.status(401).json({ error: 'Admin access denied.' })
  }

  try {
    const decoded = jwt.verify(token, process.env.ADMIN_JWT_SECRET)
    req.admin = decoded
    next()
  } catch (error) {
    return res.status(403).json({ error: 'Invalid admin token' })
  }
}

module.exports = { authenticateToken, authenticateAdmin }
