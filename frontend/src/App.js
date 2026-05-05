import React, { Suspense, lazy } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Toaster } from 'react-hot-toast'
import { ThemeProvider } from './ThemeContext'
import Login from './pages/Login'
import Register from './pages/Register'
import TermsOfService from './pages/TermsOfService'
import PrivacyPolicy from './pages/PrivacyPolicy'
import ResetPasswordPage from './pages/ResetPasswordPage'
import { useAuth } from './providers/AuthProvider'
import './App.css'

const Landing = lazy(() => import('./pages/Landing'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Leaderboard = lazy(() => import('./pages/Leaderboard'))
const TraderProfile = lazy(() => import('./pages/TraderProfile'))
const Chat = lazy(() => import('./pages/Chat'))
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'))
const AdminUsers = lazy(() => import('./pages/admin/AdminUsers'))
const AdminKYC = lazy(() => import('./pages/admin/AdminKYC'))
const AdminChallenges = lazy(() => import('./pages/admin/AdminChallenges'))
const AdminFunded = lazy(() => import('./pages/admin/AdminFunded'))
const AdminTrades = lazy(() => import('./pages/admin/AdminTrades'))
const AdminPayouts = lazy(() => import('./pages/admin/AdminPayouts'))
const AdminPlatformPnL = lazy(() => import('./pages/admin/AdminPlatformPnL'))
const AdminSettings = lazy(() => import('./pages/admin/AdminSettings'))
const AdminAccess = lazy(() => import('./pages/admin/AdminAccess'))
const AdminDisputes = lazy(() => import('./pages/admin/AdminDisputes'))
const AdminChat = lazy(() => import('./pages/admin/AdminChat'))
const AdminLeaderboard = lazy(() => import('./pages/admin/AdminLeaderboard'))
const AdminTradeCopier = lazy(() => import('./pages/admin/AdminTradeCopier'))
const AdminAccountDetail = lazy(() => import('./pages/admin/AdminAccountDetail'))
const AdminViolations = lazy(() => import('./pages/admin/AdminViolations'))
const AdminTenants = lazy(() => import('./pages/admin/AdminTenants'))
const AdminCommandCenter = lazy(() => import('./pages/admin/AdminCommandCenter'))

const pageVariants = {
  initial: { opacity: 0, y: 16 },
  animate: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] }
  },
  exit: {
    opacity: 0,
    y: -8,
    transition: { duration: 0.15 }
  }
}

export const PageWrapper = ({ children }) => (
  <motion.div
    variants={pageVariants}
    initial="initial"
    animate="animate"
    exit="exit"
    style={{ width: '100%', height: '100%' }}
  >
    {children}
  </motion.div>
)

function RouteFallback() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: 'var(--text-secondary)',
      background: 'var(--bg-base)'
    }}>
      Loading...
    </div>
  )
}

function AnimatedRoutes({ user, login, logout }) {
  const location = useLocation()

  return (
    <Suspense fallback={<RouteFallback />}>
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={user ? <Navigate to="/dashboard" replace /> : <Landing />} />
          <Route path="/terms" element={<TermsOfService />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />

          <Route
            path="/login"
            element={!user ? <Login onLogin={login} /> : <Navigate to="/dashboard" replace />}
          />
          <Route
            path="/register"
            element={!user ? <Register onLogin={login} /> : <Navigate to="/dashboard" replace />}
          />
          <Route
            path="/reset-password"
            element={!user ? <ResetPasswordPage onLogin={login} /> : <Navigate to="/dashboard" replace />}
          />

          <Route
            path="/dashboard"
            element={user ? <Dashboard user={user} onLogout={logout} /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/dashboard/*"
            element={user ? <Dashboard user={user} onLogout={logout} /> : <Navigate to="/login" replace />}
          />
          <Route
            path="/chat"
            element={user ? <Chat /> : <Navigate to="/login" replace />}
          />

          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminDashboard />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="kyc" element={<AdminKYC />} />
            <Route path="challenges" element={<AdminChallenges />} />
            <Route path="funded" element={<AdminFunded />} />
            <Route path="trades" element={<AdminTrades />} />
            <Route path="payouts" element={<AdminPayouts />} />
            <Route path="pnl" element={<AdminPlatformPnL />} />
            <Route path="settings" element={<AdminSettings />} />
            <Route path="access" element={<AdminAccess />} />
            <Route path="tenants" element={<AdminTenants />} />
            <Route path="command-center" element={<AdminCommandCenter />} />
            <Route path="disputes" element={<AdminDisputes />} />
            <Route path="chat" element={<AdminChat />} />
            <Route path="leaderboard" element={<AdminLeaderboard />} />
            <Route path="copier" element={<AdminTradeCopier />} />
            <Route path="violations" element={<AdminViolations />} />
            <Route path="accounts/:accountId" element={<AdminAccountDetail />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Route>

          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/trader/:userId" element={<TraderProfile />} />

          <Route
            path="*"
            element={<Navigate to={user ? '/dashboard' : '/'} replace />}
          />
        </Routes>
      </AnimatePresence>
    </Suspense>
  )
}

function AppRoutes() {
  const { user, authChecked, login, logout } = useAuth()

  if (!authChecked) {
    return null
  }

  return (
    <ThemeProvider initialTheme={user?.theme_preference}>
      <Toaster
        position="top-right"
        gutter={8}
        toastOptions={{
          duration: 4000,
          style: {
            background: '#111E35',
            color: '#F0F4FF',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '10px',
            fontSize: '13px',
            fontFamily: 'system-ui, sans-serif',
            padding: '12px 16px',
            boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
            maxWidth: '360px',
          },
          success: {
            iconTheme: { primary: '#00FF88', secondary: '#111E35' },
          },
          error: {
            iconTheme: { primary: '#FF3B5C', secondary: '#111E35' },
          },
        }}
      />
      <Router>
        <AnimatedRoutes user={user} login={login} logout={logout} />
      </Router>
    </ThemeProvider>
  )
}

export default function App() {
  return <AppRoutes />
}
