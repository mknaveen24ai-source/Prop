import React from 'react'
import { Moon, Sun } from 'lucide-react'
import { useTheme } from '../ThemeContext'

export default function ThemeToggle() {
  const { theme, toggleTheme } = useTheme()
  const isDark = theme === 'dark'

  return (
    <button
      type="button"
      onClick={toggleTheme}
      title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      aria-label="Toggle theme"
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        width: '56px',
        height: '28px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border-strong)',
        borderRadius: '20px',
        padding: '0 4px',
        cursor: 'pointer',
        transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        overflow: 'hidden',
        outline: 'none'
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: isDark ? 'calc(100% - 24px - 3px)' : '3px',
          transform: 'translateY(-50%)',
          width: '24px',
          height: '22px',
          background: isDark ? 'var(--accent)' : 'var(--paper)',
          borderRadius: '50%',
          transition: 'all 0.4s cubic-bezier(0.68, -0.55, 0.265, 1.55)',
          boxShadow: isDark ? '0 0 10px rgba(var(--brand-primary-rgb), 0.5)' : '0 1px 3px rgba(0,0,0,0.2)',
          zIndex: 1
        }}
      />

      <div
        style={{
          zIndex: 2,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          width: '50%',
          transition: 'color 0.3s'
        }}
      >
        <Sun size={12} color={isDark ? 'var(--text-muted)' : 'var(--bg-hover)'} />
      </div>
      <div
        style={{
          zIndex: 2,
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          width: '50%',
          transition: 'color 0.3s'
        }}
      >
        <Moon size={10} color={isDark ? 'var(--text-primary)' : 'var(--text-muted)'} />
      </div>
    </button>
  )
}
