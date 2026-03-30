/**
 * API Service Layer for PropFirm Frontend
 * Centralizes all API calls to avoid duplication across components
 */

import axios from 'axios'

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

// Create axios instance with default config
const api = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json'
  },
  withCredentials: true
})

// Request interceptor - add auth token if available
api.interceptors.request.use(
  config => {
    const token = localStorage.getItem('token')
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  error => Promise.reject(error)
)

// Response interceptor - handle global errors
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401 || error.response?.status === 403) {
      // Only logout for non-admin endpoints
      if (!error.config?.url?.includes('/api/admin')) {
        localStorage.removeItem('token')
        localStorage.removeItem('user')
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
  
  register: (data) => 
    api.post('/api/auth/register', data),
  
  logout: () => 
    api.post('/api/auth/logout'),
  
  forgotPassword: (email) => 
    api.post('/api/auth/forgot-password', { email }),
  
  resetPassword: (token, password) => 
    api.post('/api/auth/reset-password', { token, password }),
  
  getProfile: () => 
    api.get('/api/auth/profile'),
  
  updateTheme: (theme) => 
    api.patch('/api/auth/theme', { theme })
}

// ─────────────────────────────────────────────────────────────────────────────
// Accounts API
// ─────────────────────────────────────────────────────────────────────────────
export const accountsAPI = {
  getMyAccounts: () => 
    api.get('/api/accounts/my-accounts'),
  
  createAccount: (data) => 
    api.post('/api/accounts/create', data),
  
  getAccountHistory: () => 
    api.get('/api/accounts/history'),
  
  getAccountStats: (accountId) => 
    api.get(`/api/accounts/stats/${accountId}`),
  
  getAccountDetails: (accountId) => 
    api.get(`/api/accounts/${accountId}`)
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
  
  getClosedTrades: (accountId) => 
    api.get(`/api/trades/closed?account_id=${accountId}`),
  
  openTrade: (data) => 
    api.post('/api/trades/open', data),
  
  closeTrade: (tradeId) => 
    api.post('/api/trades/close', { trade_id: tradeId }),
  
  getPrices: () => 
    api.get('/api/trades/prices')
}

// ─────────────────────────────────────────────────────────────────────────────
// Payouts API
// ─────────────────────────────────────────────────────────────────────────────
export const payoutsAPI = {
  getMyPayouts: () => 
    api.get('/api/payouts/my-payouts'),
  
  requestPayout: (data) => 
    api.post('/api/payouts/request', data),
  
  getSettings: () => 
    api.get('/api/payouts/settings')
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
// Admin API
// ─────────────────────────────────────────────────────────────────────────────
export const adminAPI = {
  getOverview: () => 
    api.get('/api/admin/overview'),
  
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
    api.get('/api/support/my-tickets')
}

// ─────────────────────────────────────────────────────────────────────────────
// Analytics API
// ─────────────────────────────────────────────────────────────────────────────
export const analyticsAPI = {
  getLeaderboard: () => 
    api.get('/api/analytics/leaderboard'),
  
  getTraderStats: (userId) => 
    api.get(`/api/analytics/trader/${userId}`)
}

export default api
