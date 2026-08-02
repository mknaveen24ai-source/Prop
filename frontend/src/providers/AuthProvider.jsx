import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { authAPI } from '../services/api'

const AuthContext = createContext({
  user: null,
  authChecked: false,
  login: () => {},
  logout: async () => {},
  refreshSession: async () => null
})

axios.defaults.withCredentials = true

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)

  const refreshSession = useCallback(async () => {
    try {
      const response = await authAPI.getProfile()
      setUser(response.data || null)
      return response.data || null
    } catch {
      setUser(null)
      return null
    } finally {
      setAuthChecked(true)
    }
  }, [])

  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      response => response,
      error => {
        const status = error.response?.status
        const url = error.config?.url || ''
        const skipAuthRedirect = error.config?.skipAuthRedirect === true

        if ((status === 401 || status === 403) && !url.includes('/api/admin') && !skipAuthRedirect) {
          setUser(null)
        }

        return Promise.reject(error)
      }
    )

    return () => axios.interceptors.response.eject(interceptor)
  }, [])

  useEffect(() => {
    refreshSession()
  }, [refreshSession])

  const login = useCallback((nextUser) => {
    setUser(nextUser || null)
    setAuthChecked(true)
  }, [])

  const logout = useCallback(async () => {
    try {
      await authAPI.logout()
    } catch {
      // Best effort logout; server cookie may already be gone.
    } finally {
      setUser(null)
    }
  }, [])

  const value = useMemo(() => ({
    user,
    authChecked,
    login,
    logout,
    refreshSession
  }), [user, authChecked, login, logout, refreshSession])

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
