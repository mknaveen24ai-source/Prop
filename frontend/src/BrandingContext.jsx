import React, { createContext, useContext, useEffect, useMemo } from 'react'
import branding from './config/branding'

const BrandingContext = createContext({
  tenant: branding,
  loading: false
})

function hexToRgb(hex) {
  const clean = String(hex || '').replace('#', '')
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16)
  }
}

// WCAG relative luminance / contrast ratio — used to pick readable button
// text (black or white) against a tenant-supplied brand color, since a
// white-label primary color could be pale or dark and --paper's contrast
// only happens to work for the built-in palette, not an arbitrary hex.
function relativeLuminance({ r, g, b }) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs
}

function contrastRatio(rgb1, rgb2) {
  const l1 = relativeLuminance(rgb1)
  const l2 = relativeLuminance(rgb2)
  const lighter = Math.max(l1, l2)
  const darker = Math.min(l1, l2)
  return (lighter + 0.05) / (darker + 0.05)
}

function pickOnColor(rgb) {
  if (!rgb) return '#FFFFFF'
  const white = { r: 255, g: 255, b: 255 }
  const black = { r: 0, g: 0, b: 0 }
  return contrastRatio(rgb, white) >= contrastRatio(rgb, black) ? '#FFFFFF' : '#000000'
}

export function BrandingProvider({ children }) {
  useEffect(() => {
    const overrideVars = [
      '--brand-primary', '--brand-primary-strong', '--brand-primary-rgb', '--brand-primary-glow', '--brand-primary-soft',
      '--brand-accent', '--brand-accent-strong', '--brand-accent-rgb', '--brand-accent-glow', '--brand-accent-soft',
      '--accent', '--accent-hover', '--accent-glow', '--info', '--info-bg',
      '--admin-accent', '--admin-accent-hover', '--admin-accent-glow', '--admin-accent-bg',
      '--on-primary'
    ]

    const primary = branding?.brand?.primary_color
    const accent = branding?.brand?.accent_color

    // Only inject a hard color override when the static brand config actually
    // defines colors. Otherwise rely on tokens.css's own light/dark-aware
    // --ink cascade — a single static hex here can't be correct in both
    // themes at once.
    if (!primary || !accent) {
      overrideVars.forEach(name => document.documentElement.style.removeProperty(name))
      return
    }

    const primaryRgb = hexToRgb(primary)
    const accentRgb = hexToRgb(accent)
    // A real lighter shade for hover states, not the same flat color as rest
    // — color-mix() is already used elsewhere in this codebase for derived
    // tints (App.css, Register.jsx), so this stays consistent with that.
    const primaryHoverShade = `color-mix(in srgb, ${primary} 85%, white)`
    const onPrimary = pickOnColor(primaryRgb)

    document.documentElement.style.setProperty('--brand-primary', primary)
    document.documentElement.style.setProperty('--brand-primary-strong', primaryHoverShade)
    document.documentElement.style.setProperty('--on-primary', onPrimary)
    document.documentElement.style.setProperty('--brand-primary-rgb', primaryRgb ? `${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}` : '27, 43, 58')
    document.documentElement.style.setProperty('--brand-primary-glow', primaryRgb ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.28)` : 'rgba(27,43,58,0.28)')
    document.documentElement.style.setProperty('--brand-primary-soft', primaryRgb ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.12)` : 'rgba(27,43,58,0.12)')
    document.documentElement.style.setProperty('--brand-accent', accent)
    document.documentElement.style.setProperty('--brand-accent-strong', accent)
    document.documentElement.style.setProperty('--brand-accent-rgb', accentRgb ? `${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}` : '27, 43, 58')
    document.documentElement.style.setProperty('--brand-accent-glow', accentRgb ? `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.24)` : 'rgba(27,43,58,0.24)')
    document.documentElement.style.setProperty('--brand-accent-soft', accentRgb ? `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.12)` : 'rgba(27,43,58,0.12)')
    document.documentElement.style.setProperty('--accent', primary)
    document.documentElement.style.setProperty('--accent-hover', primaryHoverShade)
    document.documentElement.style.setProperty('--accent-glow', primaryRgb ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.28)` : 'rgba(27,43,58,0.28)')
    document.documentElement.style.setProperty('--info', accent)
    document.documentElement.style.setProperty('--info-bg', accentRgb ? `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.12)` : 'rgba(27,43,58,0.12)')
    document.documentElement.style.setProperty('--admin-accent', primary)
    document.documentElement.style.setProperty('--admin-accent-hover', primaryHoverShade)
    document.documentElement.style.setProperty('--admin-accent-glow', primaryRgb ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.28)` : 'rgba(27,43,58,0.28)')
    document.documentElement.style.setProperty('--admin-accent-bg', primaryRgb ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.12)` : 'rgba(27,43,58,0.12)')
  }, [])

  const value = useMemo(() => ({ tenant: branding, loading: false }), [])

  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  )
}

export function useBranding() {
  return useContext(BrandingContext)
}
