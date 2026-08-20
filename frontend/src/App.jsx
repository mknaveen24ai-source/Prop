import React, { Suspense, lazy, useEffect } from 'react'
import { BrowserRouter as Router, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { Toaster } from 'react-hot-toast'
import { ThemeProvider } from './ThemeContext'
import Login from './pages/Login'
import Register from './pages/Register'
import TermsOfService from './pages/TermsOfService'
import PrivacyPolicy from './pages/PrivacyPolicy'
import RefundPolicy from './pages/RefundPolicy'
import CookiePolicy from './pages/CookiePolicy'
import ResetPasswordPage from './pages/ResetPasswordPage'
import { useAuth } from './providers/AuthProvider'
import './App.css'

const Landing = lazy(() => import('./pages/Landing'))
const Checkout = lazy(() => import('./pages/Checkout'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Leaderboard = lazy(() => import('./pages/Leaderboard'))
const TraderProfile = lazy(() => import('./pages/TraderProfile'))
const Competitions = lazy(() => import('./pages/Competitions'))
const CompetitionDetail = lazy(() => import('./pages/CompetitionDetail'))
const Transparency = lazy(() => import('./pages/Transparency'))
const VerifyCertificate = lazy(() => import('./pages/VerifyCertificate'))
const AdminLayout = lazy(() => import('./pages/admin/AdminLayout'))
const AdminDashboard = lazy(() => import('./pages/admin/AdminDashboard'))
const AdminUsers = lazy(() => import('./pages/admin/AdminUsers'))
const AdminKYC = lazy(() => import('./pages/admin/AdminKYC'))
const AdminChallenges = lazy(() => import('./pages/admin/AdminChallenges'))
const AdminFunded = lazy(() => import('./pages/admin/AdminFunded'))
const AdminTrades = lazy(() => import('./pages/admin/AdminTrades'))
const AdminPayouts = lazy(() => import('./pages/admin/AdminPayouts'))
const AdminCertificates = lazy(() => import('./pages/admin/AdminCertificates'))
const AdminCertificateTemplates = lazy(() => import('./pages/admin/AdminCertificateTemplates'))
const AdminPlatformPnL = lazy(() => import('./pages/admin/AdminPlatformPnL'))
const AdminSettings = lazy(() => import('./pages/admin/AdminSettings'))
// FIX (M-02): AdminEmailJobs.jsx is a complete 492-line page calling live,
// mounted endpoints (/api/admin/email-jobs, routes/admin/index.js), but it had
// no route and no import anywhere — so email-delivery failures could not be
// inspected or retried by anyone.
const AdminEmailJobs = lazy(() => import('./pages/admin/AdminEmailJobs'))
const AdminCoupons = lazy(() => import('./pages/admin/AdminCoupons'))
const AdminGifts = lazy(() => import('./pages/admin/AdminGifts'))
const AdminReferralSeasons = lazy(() => import('./pages/admin/AdminReferralSeasons'))
const AdminTradingEconomics = lazy(() => import('./pages/admin/AdminTradingEconomics'))
const AdminStepModels = lazy(() => import('./pages/admin/AdminStepModels'))
const AdminAccess = lazy(() => import('./pages/admin/AdminAccess'))
const AdminLeaderboard = lazy(() => import('./pages/admin/AdminLeaderboard'))
const AdminAccountDetail = lazy(() => import('./pages/admin/AdminAccountDetail'))
const AdminViolations = lazy(() => import('./pages/admin/AdminViolations'))
const AdminAccountLinking = lazy(() => import('./pages/admin/AdminAccountLinking'))
const AdminSystemHealth = lazy(() => import('./pages/admin/AdminSystemHealth'))
const AdminChat = lazy(() => import('./pages/admin/AdminChat'))
const AdminDisputes = lazy(() => import('./pages/admin/AdminDisputes'))
const AdminCommandCenter = lazy(() => import('./pages/admin/AdminCommandCenter'))
const AdminPromotionReviews = lazy(() => import('./pages/admin/AdminPromotionReviews'))
const SupportAppealsCenter = lazy(() => import('./pages/admin/SupportAppealsCenter'))
const AdminAnalytics = lazy(() => import('./pages/admin/AdminAnalytics'))
const AdminCompetitions = lazy(() => import('./pages/admin/AdminCompetitions'))
const AdminCompetitionDetail = lazy(() => import('./pages/admin/AdminCompetitionDetail'))
const AdminCompetitionAnalytics = lazy(() => import('./pages/admin/AdminCompetitionAnalytics'))
const AdminAffiliates = lazy(() => import('./pages/admin/AdminAffiliates'))
const AdminAffiliateDetail = lazy(() => import('./pages/admin/AdminAffiliateDetail'))
const AdminAffiliatePayouts = lazy(() => import('./pages/admin/AdminAffiliatePayouts'))

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
      minHeight: '100dvh',
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

  // Dev-only: a page that scrolls sideways is always a bug here, and the cause
  // is usually one element inside a tree of inline styles. Reports it in the
  // console instead of leaving it to be spotted by eye. Tree-shaken from
  // production by the import.meta.env.DEV guard.
  useEffect(() => {
    if (!import.meta.env.DEV) return undefined
    const timer = setTimeout(() => {
      import('./utils/overflowGuard').then(({ findHorizontalOverflow }) => {
        findHorizontalOverflow({ label: location.pathname })
      })
    }, 600) // let route transitions and lazy chunks settle first
    return () => clearTimeout(timer)
  }, [location.pathname])

  return (
    <Suspense fallback={<RouteFallback />}>
      <AnimatePresence mode="wait">
        <Routes location={location} key={location.pathname}>
          <Route path="/" element={user ? <Navigate to="/dashboard" replace /> : <Landing />} />
          <Route path="/terms" element={<TermsOfService />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/refund-policy" element={<RefundPolicy />} />
          <Route path="/cookie-policy" element={<CookiePolicy />} />
          <Route path="/checkout" element={<Checkout />} />

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
            element={<Navigate to={user ? '/dashboard/chat' : '/login'} replace />}
          />

          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminDashboard />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="kyc" element={<AdminKYC />} />
            <Route path="challenges" element={<AdminChallenges />} />
            <Route path="funded" element={<AdminFunded />} />
            <Route path="trades" element={<AdminTrades />} />
            <Route path="analytics" element={<AdminAnalytics />} />
            <Route path="payouts" element={<AdminPayouts />} />
            <Route path="certificates" element={<AdminCertificates />} />
            <Route path="certificates/templates" element={<AdminCertificateTemplates />} />
            <Route path="affiliates" element={<AdminAffiliates />} />
            <Route path="affiliates/payouts" element={<AdminAffiliatePayouts />} />
            <Route path="affiliates/:userId" element={<AdminAffiliateDetail />} />
            <Route path="pnl" element={<AdminPlatformPnL />} />
            <Route path="settings" element={<AdminSettings />} />
            <Route path="email-jobs" element={<AdminEmailJobs />} />
            <Route path="coupons" element={<AdminCoupons />} />
            <Route path="gifts" element={<AdminGifts />} />
            <Route path="trading-economics" element={<AdminTradingEconomics />} />
            <Route path="step-models" element={<AdminStepModels />} />
            <Route path="access" element={<AdminAccess />} />
            <Route path="command-center" element={<AdminCommandCenter />} />
            <Route path="promotion-reviews" element={<AdminPromotionReviews />} />
            <Route path="leaderboard" element={<AdminLeaderboard />} />
            <Route path="violations" element={<AdminViolations />} />
            <Route path="account-linking" element={<AdminAccountLinking />} />
            <Route path="system-health" element={<AdminSystemHealth />} />
            <Route path="chat" element={<AdminChat />} />
            <Route path="disputes" element={<AdminDisputes />} />
            <Route path="competitions" element={<AdminCompetitions />} />
            <Route path="referral-seasons" element={<AdminReferralSeasons />} />
            <Route path="competitions/:id" element={<AdminCompetitionDetail />} />
            <Route path="competitions/:id/analytics" element={<AdminCompetitionAnalytics />} />
            <Route path="accounts/:accountId" element={<AdminAccountDetail />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </Route>

          <Route path="/admin/support-appeals-center" element={<SupportAppealsCenter />} />

          <Route path="/leaderboard" element={<Leaderboard />} />
          <Route path="/trader/:userId" element={<TraderProfile />} />
          <Route path="/competitions" element={<Competitions />} />
          <Route path="/competitions/:slug" element={<CompetitionDetail />} />
          <Route path="/transparency" element={<Transparency />} />
          <Route path="/verify/:publicId" element={<VerifyCertificate />} />

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
            background: 'var(--paper-2)',
            color: 'var(--ink)',
            border: '1px solid var(--rule)',
            fontSize: 'var(--fs-base)',
            fontFamily: 'var(--font-ui, system-ui, sans-serif)',
            padding: 'var(--space-3) var(--space-4)',
            maxWidth: '360px',
          },
          success: {
            iconTheme: { primary: 'var(--gain)', secondary: 'var(--paper-2)' },
          },
          error: {
            iconTheme: { primary: 'var(--loss)', secondary: 'var(--paper-2)' },
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
