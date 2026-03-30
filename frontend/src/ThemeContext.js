import React, { createContext, useContext, useState, useEffect } from 'react'
import axios from 'axios'

const ThemeContext = createContext()
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:5000'

export function ThemeProvider({ children, initialTheme }) {
  // FIX: Wrap localStorage access in try/catch.
  // localStorage.getItem throws in some strict privacy modes (Firefox with
  // enhanced tracking protection, Safari ITP, and certain embedded webviews).
  // Without the guard the entire ThemeProvider — and therefore the whole app —
  // crashes before anything renders.
  const [theme, setTheme] = useState(() => {
    try {
      return initialTheme || localStorage.getItem('theme') || 'dark'
    } catch {
      return initialTheme || 'dark'
    }
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
    try {
      localStorage.setItem('theme', theme)
    } catch {
      // Non-fatal — theme still applied to DOM, just won't persist across sessions
    }
  }, [theme])

  function toggleTheme() {
    const newTheme = theme === 'dark' ? 'light' : 'dark'
    setTheme(newTheme)

    // Persist to DB (non-fatal — localStorage already saved it locally)
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