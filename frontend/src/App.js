import React, { useState, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom'
import axios from 'axios'
import Landing from './pages/Landing'
import Login from './pages/Login'
import Register from './pages/Register'
import Dashboard from './pages/Dashboard'
import Admin from './pages/Admin'
import TermsOfService from './pages/TermsOfService'
import PrivacyPolicy from './pages/PrivacyPolicy'
import Leaderboard from './pages/Leaderboard'
import TraderProfile from './pages/TraderProfile'
import Chat from './pages/Chat'
import { ThemeProvider } from './ThemeContext'
import ErrorBoundary from './ErrorBoundary'
import './App.css'

axios.defaults.withCredentials = true

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

function App() {
  const [user, setUser] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)

  function handleLogin(newUser) {
    setUser(newUser)
  }

  async function handleLogout() {
    try { await axios.post(`${API_URL}/api/auth/logout`) } catch {}
    setUser(null)
  }

  // Global axios interceptor — automatically logs out on 401/403.
  // Skips /api/admin routes because the Admin page manages its own auth state.
  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      response => response,
      error => {
        const status = error.response?.status
        const url    = error.config?.url || ''

        if ((status === 401 || status === 403) && !url.includes('/api/admin')) {
          setUser(null)
        }

        return Promise.reject(error)
      }
    )

    return () => axios.interceptors.response.eject(interceptor)
  }, [])

  useEffect(() => {
    async function checkAuth() {
      try {
        const res = await axios.get(`${API_URL}/api/auth/me`)
        setUser(res.data)
      } catch {
        setUser(null)
      } finally {
        setAuthChecked(true)
      }
    }
    checkAuth()
  }, [])

  if (!authChecked) {
    return null
  }

  return (
    // Pass user's DB theme preference so ThemeProvider syncs across devices
    <ThemeProvider initialTheme={user?.theme_preference}>
      <ErrorBoundary>
        <Router>
          <Routes>

          {/* -- Public routes — logged-in users go straight to dashboard -- */}
          <Route path="/"        element={user ? <Navigate to="/dashboard" replace /> : <Landing />} />
          <Route path="/terms"   element={<TermsOfService />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />

          {/* -- Auth routes — redirect to dashboard if already logged in -- */}
          <Route
            path="/login"
            element={!user ? <Login onLogin={handleLogin} /> : <Navigate to="/dashboard" replace />}
          />
          <Route
            path="/register"
            element={!user ? <Register onLogin={handleLogin} /> : <Navigate to="/dashboard" replace />}
          />

          {/*
            /reset-password route — Login.js detects ?token=&email= params
            on mount and switches itself into "reset password" mode automatically.
            Redirects to /dashboard if already logged in (no need to reset if authed).
          */}
          <Route
            path="/reset-password"
            element={!user ? <Login onLogin={handleLogin} /> : <Navigate to="/dashboard" replace />}
          />

          {/* -- Protected routes — redirect to /login if not authenticated -- */}
          <Route
            path="/dashboard"
            element={user ? <Dashboard user={user} onLogout={handleLogout} /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/dashboard/*"
            element={user ? <Dashboard user={user} onLogout={handleLogout} /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/chat"
            element={user ? <Chat /> : <Navigate to="/login" replace />}
          />

          {/*
            Admin route — no client-side token guard needed.
            The Admin component shows its own login form before rendering anything.
            Every API call it makes is verified by the backend with its own JWT.
          */}
          <Route path="/admin"   element={<Admin />} />
          <Route path="/admin/*" element={<Admin />} />

          {/* -- Public pages -- */}
          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/trader/:userId" element={<TraderProfile />} />

          {/*
            Catch-all 404 — redirect to a safe landing
            Logged-in users -> /dashboard
            Logged-out users -> /
          */}
          <Route
            path="*"
            element={<Navigate to={user ? '/dashboard' : '/'} replace />}
          />

        </Routes>
        </Router>
      </ErrorBoundary>
    </ThemeProvider>
  )
}

export default App