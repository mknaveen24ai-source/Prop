import React, { createContext, useContext, useState, useEffect } from 'react'
import axios from 'axios'
import { getTenantHeaders } from './utils/tenant'

const ThemeContext = createContext()
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

export function ThemeProvider({ children, initialTheme }) {
  // FIX: Keep theme in React state and DB preference only.
  // Browser storage access throws in some strict privacy modes (Firefox with
  // enhanced tracking protection, Safari ITP, and certain embedded webviews).
  // Without the guard the entire ThemeProvider — and therefore the whole app —
  // crashes before anything renders.
  const [theme, setTheme] = useState(() => {
    return initialTheme || 'dark'
  })

  // Sync initialTheme when it arrives from the /me response in App.js.
  // We intentionally do NOT list `theme` as a dependency here — if we did,
  // any local toggle would immediately be overwritten by the prop value on
  // the next render cycle. The goal is to apply the DB preference once on
  // first load, then let the user toggle freely after that.
  useEffect(() => {
    if (initialTheme && initialTheme !== theme) {
      setTheme(initialTheme)
    }
  }, [initialTheme]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  function toggleTheme() {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)

    // Persist to DB; the current page already applied the theme locally.
    axios.patch(`${API_URL}/api/auth/theme`, { theme: newTheme }, { headers: getTenantHeaders() }).catch(() => {})
  }

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  )
}

export function useTheme() {
  return useContext(ThemeContext)
}
