import React, { useState } from 'react'
import axios from 'axios'

function Register({ onLogin }) {
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    password: '',
    country: '',
    phone: '',
    referred_by: ''
  })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  function handleChange(e) {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await axios.post('http://localhost:5000/api/auth/register', form)
      onLogin(response.data.token, response.data.user)
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed')
    }
    setLoading(false)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div className="card" style={{ width: '450px' }}>
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <h1 className="gold" style={{ fontSize: '28px' }}>PROP FIRM</h1>
          <p style={{ color: '#888', marginTop: '8px' }}>Create your free account</p>
        </div>

        {error && <div className="error">{error}</div>}

        <form onSubmit={handleSubmit}>
          <label style={{ fontSize: '12px', color: '#888' }}>FULL NAME</label>
          <input
            type="text"
            name="full_name"
            value={form.full_name}
            onChange={handleChange}
            placeholder="John Smith"
            required
          />

          <label style={{ fontSize: '12px', color: '#888' }}>EMAIL</label>
          <input
            type="email"
            name="email"
            value={form.email}
            onChange={handleChange}
            placeholder="your@email.com"
            required
          />

          <label style={{ fontSize: '12px', color: '#888' }}>PASSWORD</label>
          <input
            type="password"
            name="password"
            value={form.password}
            onChange={handleChange}
            placeholder="Minimum 8 characters"
            required
          />

          <label style={{ fontSize: '12px', color: '#888' }}>COUNTRY</label>
          <select name="country" value={form.country} onChange={handleChange} required>
            <option value="">Select your country</option>
            <option value="India">India</option>
            <option value="United Kingdom">United Kingdom</option>
            <option value="Australia">Australia</option>
            <option value="UAE">UAE</option>
            <option value="South Africa">South Africa</option>
            <option value="Nigeria">Nigeria</option>
            <option value="Malaysia">Malaysia</option>
            <option value="Singapore">Singapore</option>
            <option value="Philippines">Philippines</option>
            <option value="Kenya">Kenya</option>
            <option value="Pakistan">Pakistan</option>
            <option value="Bangladesh">Bangladesh</option>
            <option value="Other">Other</option>
          </select>

          <label style={{ fontSize: '12px', color: '#888' }}>PHONE / WHATSAPP</label>
          <input
            type="text"
            name="phone"
            value={form.phone}
            onChange={handleChange}
            placeholder="+91 9999999999"
            required
          />

          <label style={{ fontSize: '12px', color: '#888' }}>REFERRAL CODE (optional)</label>
          <input
            type="text"
            name="referred_by"
            value={form.referred_by}
            onChange={handleChange}
            placeholder="Enter referral code if you have one"
          />

          <button
            className="btn btn-gold"
            type="submit"
            style={{ width: '100%', marginTop: '8px' }}
            disabled={loading}
          >
            {loading ? 'Creating account...' : 'Create Free Account'}
          </button>
        </form>

        <p style={{ textAlign: 'center', marginTop: '24px', color: '#888', fontSize: '14px' }}>
          Already have an account?{' '}
          <a href="/login" style={{ color: '#c9a84c' }}>Sign in here</a>
        </p>
      </div>
    </div>
  )
}

export default Register
