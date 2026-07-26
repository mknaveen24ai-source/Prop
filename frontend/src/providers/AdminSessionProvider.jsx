import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { io } from 'socket.io-client'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const adminAxios = axios.create({
  baseURL: API_URL,
  withCredentials: true
})

const defaultSession = {
  authenticated: false,
  adminId: null,
  role: null,
  permissions: [],
  email: null,
  full_name: null,
  auth_source: null,
  totp_enabled: false
}

const AdminSessionContext = createContext({
  adminAxios,
  checking: true,
  isAuthenticated: false,
  session: defaultSession,
  socket: null,
  refreshSession: async () => defaultSession,
  logout: async () => {}
})

function normalizeSessionPayload(payload) {
  return {
    ...defaultSession,
    ...(payload || {}),
    authenticated: payload?.authenticated === true,
    permissions: Array.isArray(payload?.permissions) ? payload.permissions : []
  }
}

export function AdminSessionProvider({ children }) {
  const [session, setSession] = useState(defaultSession)
  const [checking, setChecking] = useState(true)
  const [socket, setSocket] = useState(null)

  useEffect(() => {
    const interceptor = adminAxios.interceptors.response.use(
      response => response,
      error => {
        if (error.response?.status === 401) {
          setSession(defaultSession)
        }
        return Promise.reject(error)
      }
    )

    return () => adminAxios.interceptors.response.eject(interceptor)
  }, [])

  const refreshSession = useCallback(async () => {
    try {
      const response = await adminAxios.get('/api/admin/session')
      const nextSession = normalizeSessionPayload(response.data)
      setSession(nextSession)
      return nextSession
    } catch {
      setSession(defaultSession)
      return defaultSession
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    refreshSession()
  }, [refreshSession])

  useEffect(() => {
    if (!session.authenticated) {
      setSocket((current) => {
        if (current) {
          current.disconnect()
        }
        return null
      })
      return undefined
    }

    const socketInstance = io(API_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: true
    })

    socketInstance.on('auth_error', () => {
      setSession(defaultSession)
    })

    setSocket(socketInstance)

    return () => {
      socketInstance.disconnect()
      setSocket(null)
    }
  }, [session.authenticated])

  const logout = useCallback(async () => {
    try {
      await adminAxios.post('/api/admin/logout')
    } catch {
      // Best effort logout; session state is still cleared locally.
    } finally {
      setSession(defaultSession)
    }
  }, [])

  const value = useMemo(() => ({
    adminAxios,
    checking,
    isAuthenticated: session.authenticated,
    session,
    socket,
    refreshSession,
    logout
  }), [checking, logout, refreshSession, session, socket])

  return (
    <AdminSessionContext.Provider value={value}>
      {children}
    </AdminSessionContext.Provider>
  )
}

export function useAdminSession() {
  return useContext(AdminSessionContext)
}
