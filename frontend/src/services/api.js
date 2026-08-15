/**
 * API Service Layer for PropFirm Frontend
 * Centralizes all API calls to avoid duplication across components
 */

import axios from 'axios'
import { setMemoryItem } from '../utils/memoryStore'
import { API_BASE_URL as API_URL } from '../config/apiBase'


function randomToken() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export function createIdempotencyKey(scope = 'request') {
  return `${scope}:${randomToken()}`
}

export function createIdempotencyHeaders(scope = 'request') {
  return {
    'Idempotency-Key': createIdempotencyKey(scope)
  }
}

export function normalizeApiError(error, fallbackMessage = 'Request failed') {
  const payload = error?.response?.data
  if (payload?.error && typeof payload.error === 'object') {
    return {
      code: payload.error.code || null,
      message: payload.error.message || fallbackMessage,
      details: payload.error.details || null,
      status: error?.response?.status || null
    }
  }
  if (typeof payload?.error === 'string') {
    return {
      code: null,
      message: payload.error,
      details: null,
      status: error?.response?.status || null
    }
  }
  // BUG-10 FIX: Check payload.message before falling back to the axios error
  // message. Some backend endpoints return { message: '...' } instead of
  // { error: '...' }. Without this check, callers saw a generic axios error
  // (e.g. "Request failed with status code 200") instead of the real message.
  if (typeof payload?.message === 'string') {
    return {
      code: null,
      message: payload.message,
      details: null,
      status: error?.response?.status || null
    }
  }
  return {
    code: null,
    message: error?.message || fallbackMessage,
    details: null,
    status: error?.response?.status || null
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function requestWithRetry(requestFn, options = {}) {
  const retries = Number.isFinite(options.retries) ? options.retries : 2
  const baseDelayMs = Number.isFinite(options.baseDelayMs) ? options.baseDelayMs : 250

  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestFn()
    } catch (error) {
      lastError = error
      const status = error?.response?.status
      const retryable = !status || status >= 500
      if (!retryable || attempt === retries) break
      await wait(baseDelayMs * (attempt + 1))
    }
  }

  throw lastError
}

// Create axios instance with default config
const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  withCredentials: true
})

// NOTE: The request interceptor deliberately does NOT attach auth. The backend
// sets the JWT as an httpOnly cookie which axios sends automatically via
// withCredentials: true. Storing the token in browser storage creates an XSS
// theft vector — any injected script can read it. The httpOnly cookie is
// inaccessible to JavaScript.
//
// It attaches a request id instead. The backend echoes it on X-Request-ID and
// stamps it on every log line written while handling the request, so a error
// reported from the UI can be traced to the exact server-side log entry.
api.interceptors.request.use((config) => {
  config.headers = config.headers || {}
  if (!config.headers['X-Request-ID']) {
    config.headers['X-Request-ID'] = randomToken()
  }
  return config
})

// Response interceptor - handle global errors
api.interceptors.response.use(
    response => response,
    error => {
      if (error.response?.status === 401) {
        // FIX (HIGH #11): Only redirect for foreground requests, not background
        // polling or analytics calls, so the UI does not lose state unexpectedly.
        const isBackgroundRequest = error.config?.url?.includes('/prices') ||
                                    error.config?.url?.includes('/ping') ||
                                    error.config?.url?.includes('/analytics')
        // BUG-22 FIX: Read skipAuthRedirect from config directly (it IS passed
        // through by axios as a custom config property). Added inline comment
        // so future developers know this is intentional axios behavior.
        const skipAuthRedirect = error.config?.skipAuthRedirect === true
      
      if (!isBackgroundRequest && !skipAuthRedirect && !window.location.pathname.includes('/login')) {
        // Save current location for redirect back after login
        setMemoryItem('redirectAfterLogin', window.location.pathname + window.location.search)
        window.location.href = '/login'
      }
    }
    return Promise.reject(error)
  }
)

// ─────────────────────────────────────────────────────────────────────────────
// Authentication API
// ─────────────────────────────────────────────────────────────────────────────
export const authAPI = {
  login: (email, password) => 
    api.post('/api/auth/login', { email, password }),

  validateTwoFactor: (pre2faToken, token) =>
    api.post(
      '/api/auth/2fa/validate',
      { token },
      { headers: { Authorization: `Bearer ${pre2faToken}` } }
    ),
  
  register: (data) => 
    api.post('/api/auth/register', data),
  
  logout: () => 
    api.post('/api/auth/logout'),
  
  forgotPassword: (email) => 
    api.post('/api/auth/forgot-password', { email }),
  
  resetPassword: (email, token, new_password) => 
    api.post('/api/auth/reset-password', { email, token, new_password }),
  
  // BUG-22 NOTE: skipAuthRedirect is a custom axios config property.
  // Axios passes all config keys through to error.config in interceptors,
  // which is how the response interceptor reads it to skip the /login redirect.
  // This is documented axios behavior (not undocumented) since axios v0.19+.
  getProfile: () => 
    api.get('/api/auth/me', { skipAuthRedirect: true }),
  
  updateTheme: (theme) =>
    api.patch('/api/auth/theme', { theme }),

  updateProfile: (data) =>
    api.patch('/api/auth/profile', data)
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts API
// ─────────────────────────────────────────────────────────────────────────────
export const accountsAPI = {
  getMyAccounts: () => 
    api.get('/api/accounts/my-accounts'),

  getPublicStepModels: () =>
    api.get('/api/accounts/step-models-public', {
      timeout: 5000,
      params: { _t: Date.now() },
      headers: { 'Cache-Control': 'no-cache' }
    }),

  getPlatformRules: () =>
    api.get('/api/accounts/platform-rules'),

  getPurchaseLimit: () =>
    api.get('/api/accounts/my-purchase-limit'),

  createChallengeOrder: (data) =>
    api.post('/api/accounts/orders', data),

  validateCoupon: (code, params) =>
    api.get(`/api/accounts/coupons/validate/${encodeURIComponent(code)}`, { params }),

  createAccount: (data) => 
    api.post('/api/accounts/create', data, { headers: createIdempotencyHeaders('accounts:create') }),
  
  getAccountHistory: () => 
    api.get('/api/accounts/history'),
  
  getAccountStats: (accountId) => 
    api.get(`/api/accounts/stats/${accountId}`),
  
  // Backend has /api/accounts/stats/:account_id (no /api/accounts/:id route).
  getAccountDetails: (accountId) => 
    api.get(`/api/accounts/stats/${accountId}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// Trades API
// ─────────────────────────────────────────────────────────────────────────────
export const tradesAPI = {
  getOpenTrades: (accountId) => 
    api.get(`/api/trades/open?account_id=${accountId}`),
  
  getPendingTrades: (accountId) => 
    api.get(`/api/trades/pending?account_id=${accountId}`),
  
  getTradeHistory: (accountId) => 
    api.get(`/api/trades/history?account_id=${accountId}`),
  
  // Backend exposes /api/trades/history (no /api/trades/closed route).
  getClosedTrades: (accountId) => 
    api.get(`/api/trades/history?account_id=${accountId}`).then((response) => ({
      ...response,
      data: Array.isArray(response.data)
        ? response.data.filter(trade => trade.status === 'closed')
        : response.data
    })),
  
  openTrade: (data) => 
    api.post('/api/trades/open', data, { headers: createIdempotencyHeaders('trades:open') }),
  
  closeTrade: (tradeId) => 
    api.post('/api/trades/close', { trade_id: tradeId }),
  
  getPrices: () => 
    requestWithRetry(() => api.get('/api/prices'))
}

// ─────────────────────────────────────────────────────────────────────────────
// Payouts API
// ─────────────────────────────────────────────────────────────────────────────
export const payoutsAPI = {
  getMyPayouts: () => 
    api.get('/api/payouts/my-payouts'),
  
  requestPayout: (data) => 
    api.post('/api/payouts/request', data, { headers: createIdempotencyHeaders('payouts:request') }),
  
  getSettings: () => 
    api.get('/api/payouts/settings')
}

// ─────────────────────────────────────────────────────────────────────────────
// Affiliate API
// ─────────────────────────────────────────────────────────────────────────────
export const affiliateAPI = {
  getMe: () =>
    api.get('/api/affiliates/me'),

  getMyDiscountEligibility: () =>
    api.get('/api/affiliates/my-discount-eligibility'),

  getReferrals: (params) =>
    api.get('/api/affiliates/referrals', { params }),

  getCommissions: (params) =>
    api.get('/api/affiliates/commissions', { params }),

  getPayouts: (params) =>
    api.get('/api/affiliates/payouts', { params }),

  getAnalytics: () =>
    api.get('/api/affiliates/analytics'),

  requestPayout: (data) =>
    api.post('/api/affiliates/payouts/request', data, { headers: createIdempotencyHeaders('affiliate-payouts:request') }),

  validateCode: (code) =>
    api.get(`/api/affiliates/validate-code/${encodeURIComponent(code)}`),

  getPublicSettings: () =>
    api.get('/api/affiliates/settings-public')
}

// ─────────────────────────────────────────────────────────────────────────────
// Referral Season API — time-boxed referral leaderboard with prize vouchers,
// separate from the lifetime affiliate program above (see affiliateAPI).
// ─────────────────────────────────────────────────────────────────────────────
export const referralSeasonAPI = {
  list: (params) =>
    api.get('/api/referral-seasons', { params }),

  getBySlug: (slug) =>
    api.get(`/api/referral-seasons/${encodeURIComponent(slug)}`),

  getLeaderboard: (slug) =>
    api.get(`/api/referral-seasons/${encodeURIComponent(slug)}/leaderboard`),

  getMyVouchers: () =>
    api.get('/api/referral-seasons/vouchers/mine')
}

// ─────────────────────────────────────────────────────────────────────────────
// KYC API
// ─────────────────────────────────────────────────────────────────────────────
export const kycAPI = {
  uploadDocuments: (formData) => 
    api.post('/api/kyc/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    }),
  
  getStatus: () => 
    api.get('/api/kyc/status')
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat API
// ─────────────────────────────────────────────────────────────────────────────
export const chatAPI = {
  getConversations: () => 
    api.get('/api/chat/conversations'),
  
  createConversation: (subject) => 
    api.post('/api/chat/conversations', { subject }),
  
  getMessages: (conversationId) => 
    api.get(`/api/chat/conversations/${conversationId}`),
  
  sendMessage: (conversationId, message) =>
    api.post(`/api/chat/conversations/${conversationId}/messages`, { message })
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications API — the trader's own persisted notification history
// ─────────────────────────────────────────────────────────────────────────────
export const notificationsAPI = {
  getMine: () =>
    api.get('/api/notifications'),

  markAllRead: () =>
    api.post('/api/notifications/mark-all-read'),

  clearAll: () =>
    api.delete('/api/notifications')
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin API
// ─────────────────────────────────────────────────────────────────────────────
export const adminAPI = {
  getSession: () =>
    api.get('/api/admin/session'),

  getOverview: () => 
    api.get('/api/admin/overview'),

  getViolations: (params = {}) =>
    api.get('/api/admin/violations', { params }),

  getViolationSummary: () =>
    api.get('/api/admin/violations/summary'),

  resolveViolation: (violationId, note) =>
    api.post(`/api/admin/violations/${violationId}/resolve`, { note }),
  
  getTraders: () => 
    api.get('/api/admin/traders'),
  
  getAccounts: () => 
    api.get('/api/admin/accounts'),
  
  getPayouts: () => 
    api.get('/api/admin/payouts'),
  
  approveKYC: (userId) => 
    api.post('/api/admin/kyc/approve', { user_id: userId }),
  
  rejectKYC: (userId, reason) => 
    api.post('/api/admin/kyc/reject', { user_id: userId, reason }),
  
  banUser: (userId, reason) => 
    api.post('/api/admin/ban', { user_id: userId, reason }),
  
  getAnnouncement: () =>
    api.get('/api/admin/announcement'),

  setAnnouncement: (message) =>
    api.post('/api/admin/announcement', { message })
}

// ─────────────────────────────────────────────────────────────────────────────
// Support/Disputes API
// ─────────────────────────────────────────────────────────────────────────────
export const supportAPI = {
  submitDispute: (data) => 
    api.post('/api/disputes/submit', data),
  
  getMyDisputes: () => 
    api.get('/api/disputes/my-disputes'),
  
  submitTicket: (data) => 
    api.post('/api/support/ticket', data),
  
  getMyTickets: () => 
    api.get('/api/support/tickets')
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics API
// ─────────────────────────────────────────────────────────────────────────────
export const analyticsAPI = {
  getLeaderboard: () => 
    api.get('/api/leaderboard'),
  
  getTraderStats: (userId) => 
    api.get(`/api/auth/profile/${userId}`)
}

export default api
