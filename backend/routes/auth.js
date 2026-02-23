const express = require('express')
const router = express.Router()
const bcrypt = require('bcryptjs')
const jwt = require('jsonwebtoken')
const { v4: uuidv4 } = require('uuid')
const pool = require('../db')
require('dotenv').config()

const BLOCKED_COUNTRIES = ['United States', 'Canada', 'Iran', 'North Korea', 'Cuba', 'Syria']

const BLOCKED_EMAIL_DOMAINS = [
  'tempmail.com', 'guerrillamail.com', 'mailinator.com',
  'throwaway.email', 'fakeinbox.com', '10minutemail.com',
  'yopmail.com', 'trashmail.com', 'sharklasers.com'
]

router.post('/register', async function(req, res) {
  try {
    const { email, password, full_name, country, phone, referred_by, device_fingerprint } = req.body

    if (!email || !password || !full_name || !country || !phone) {
      return res.status(400).json({ error: 'All fields are required' })
    }

    if (BLOCKED_COUNTRIES.includes(country)) {
      return res.status(403).json({ error: 'Sorry this country is not supported' })
    }

    const emailDomain = email.split('@')[1]
    if (BLOCKED_EMAIL_DOMAINS.includes(emailDomain)) {
      return res.status(403).json({ error: 'Please use a real email address' })
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' })
    }

    const existingUser = await pool.query(
      'SELECT id FROM users WHERE email = $1',
      [email.toLowerCase()]
    )
    if (existingUser.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' })
    }

    if (device_fingerprint) {
      const existingDevice = await pool.query(
        'SELECT id FROM users WHERE device_fingerprint = $1',
        [device_fingerprint]
      )
      if (existingDevice.rows.length > 0) {
        return res.status(403).json({ error: 'An account already exists from this device' })
      }
    }

    const password_hash = await bcrypt.hash(password, 12)
    const affiliate_code = uuidv4().substring(0, 8).toUpperCase()

    const newUser = await pool.query(
      `INSERT INTO users 
       (email, password_hash, full_name, country, phone, referred_by, device_fingerprint, affiliate_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, email, full_name, country, kyc_status, affiliate_code`,
      [
        email.toLowerCase(),
        password_hash,
        full_name,
        country,
        phone,
        referred_by || null,
        device_fingerprint || null,
        affiliate_code
      ]
    )

    const user = newUser.rows[0]

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.status(201).json({
      message: 'Account created successfully',
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        country: user.country,
        kyc_status: user.kyc_status,
        affiliate_code: user.affiliate_code
      }
    })

  } catch (error) {
    console.error('Register error:', error.message)
    res.status(500).json({ error: 'Server error during registration' })
  }
})

router.post('/login', async function(req, res) {
  try {
    const { email, password } = req.body

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' })
    }

    const result = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email.toLowerCase()]
    )

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const user = result.rows[0]

    if (user.is_banned) {
      return res.status(403).json({ error: 'Account has been suspended' })
    }

    const validPassword = await bcrypt.compare(password, user.password_hash)
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN }
    )

    res.json({
      message: 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        full_name: user.full_name,
        country: user.country,
        kyc_status: user.kyc_status,
        affiliate_code: user.affiliate_code
      }
    })

  } catch (error) {
    console.error('Login error:', error.message)
    res.status(500).json({ error: 'Server error during login' })
  }
})

module.exports = router
