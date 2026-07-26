import React from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

const authState = {
  user: null,
  authChecked: true,
  login: vi.fn(),
  logout: vi.fn()
}

vi.mock('./providers/AuthProvider', () => ({
  useAuth: () => authState
}))

vi.mock('./pages/Landing', () => ({
  default: () => <div>landing-page</div>
}))
vi.mock('./pages/Login', () => ({
  default: () => <div>login-page</div>
}))
vi.mock('./pages/Register', () => ({
  default: () => <div>register-page</div>
}))
vi.mock('./pages/ResetPasswordPage', () => ({
  default: () => <div>reset-password-page</div>
}))
vi.mock('./pages/Dashboard', () => ({
  default: () => <div>dashboard-page</div>
}))
vi.mock('./pages/TermsOfService', () => ({
  default: () => <div>terms-page</div>
}))
vi.mock('./pages/PrivacyPolicy', () => ({
  default: () => <div>privacy-page</div>
}))
vi.mock('./pages/Leaderboard', () => ({
  default: () => <div>leaderboard-page</div>
}))
vi.mock('./pages/TraderProfile', () => ({
  default: () => <div>trader-profile-page</div>
}))
vi.mock('./pages/Chat', () => ({
  default: () => <div>chat-page</div>
}))
vi.mock('./pages/admin/AdminLayout', () => ({
  default: () => <div>admin-layout</div>
}))
vi.mock('./pages/admin/AdminDashboard', () => ({
  default: () => <div>admin-dashboard</div>
}))
vi.mock('./pages/admin/AdminUsers', () => ({ default: () => <div>admin-users</div> }))
vi.mock('./pages/admin/AdminKYC', () => ({ default: () => <div>admin-kyc</div> }))
vi.mock('./pages/admin/AdminChallenges', () => ({ default: () => <div>admin-challenges</div> }))
vi.mock('./pages/admin/AdminFunded', () => ({ default: () => <div>admin-funded</div> }))
vi.mock('./pages/admin/AdminTrades', () => ({ default: () => <div>admin-trades</div> }))
vi.mock('./pages/admin/AdminPayouts', () => ({ default: () => <div>admin-payouts</div> }))
vi.mock('./pages/admin/AdminPlatformPnL', () => ({ default: () => <div>admin-pnl</div> }))
vi.mock('./pages/admin/AdminSettings', () => ({ default: () => <div>admin-settings</div> }))
vi.mock('./pages/admin/AdminDisputes', () => ({ default: () => <div>admin-disputes</div> }))
vi.mock('./pages/admin/AdminChat', () => ({ default: () => <div>admin-chat</div> }))
vi.mock('./pages/admin/AdminLeaderboard', () => ({ default: () => <div>admin-leaderboard</div> }))
vi.mock('./pages/admin/AdminTradeCopier', () => ({ default: () => <div>admin-copier</div> }))
vi.mock('./pages/admin/AdminAccountDetail', () => ({ default: () => <div>admin-account-detail</div> }))
vi.mock('./pages/admin/AdminViolations', () => ({ default: () => <div>admin-violations</div> }))
vi.mock('./pages/admin/AdminCommandCenter', () => ({ default: () => <div>admin-command-center</div> }))

describe('App routing', () => {
  beforeEach(() => {
    authState.user = null
    authState.authChecked = true
    window.history.pushState({}, '', '/')
  })

  it('renders landing at the root route when logged out', async () => {
    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('landing-page')).toBeInTheDocument()
    })
  })

  it('renders the dedicated reset-password route when logged out', async () => {
    window.history.pushState({}, '', '/reset-password?token=abc&email=test@example.com')

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('reset-password-page')).toBeInTheDocument()
    })
  })

  it('redirects protected dashboard access to login when logged out', async () => {
    window.history.pushState({}, '', '/dashboard')

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('login-page')).toBeInTheDocument()
    })
  })

  it('redirects authenticated users from root to dashboard', async () => {
    authState.user = { id: 'u1', email: 'trader@example.com' }

    render(<App />)

    await waitFor(() => {
      expect(screen.getByText('dashboard-page')).toBeInTheDocument()
    })
  })
})
