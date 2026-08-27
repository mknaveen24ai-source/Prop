import React, { createContext, useContext, useState, useEffect } from 'react'
import axios from 'axios'
import { API_BASE_URL as API_URL } from './config/apiBase'

const ThemeContext = createContext()

export function ThemeProvider({ children, initialTheme }) {
  // FIX: Keep theme in React state and DB preference only.
  // Browser storage access throws in some strict privacy modes (Firefox with
  // enhanced tracking protection, Safari ITP, and certain embedded webviews).
  // Without the guard the entire ThemeProvider — and therefore the whole app —
  // crashes before anything renders.
  const [localTheme, setLocalTheme] = useState(null)
  const theme = localTheme || initialTheme || 'light'

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
  }, [theme])

  function toggleTheme() {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setLocalTheme(newTheme)

    // Persist to DB; the current page already applied the theme locally.
    axios.patch(`${API_URL}/api/auth/theme`, { theme: newTheme }).catch(() => {})
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
