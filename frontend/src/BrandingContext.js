import React, { createContext, useContext, useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { getTenantHeaders, getTenantSlug } from './utils/tenant'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000'

const defaultTenant = {
  slug: 'default',
  name: 'PropFirm',
  logo_text: 'PropFirm',
  logo_url: null,
  support_email: null,
  email_from_name: 'PropFirm',
  settings: {
    requires_payment: 'false',
    challenge_checkout_mode: 'free',
    challenge_fee_amount: '0',
    challenge_fee_currency: 'USD',
    challenge_fee_label: 'FREE',
    marketing_mode: 'free',
    max_accounts_per_user: '5'
  },
  payment_available: false,
  feed_health: {
    healthy: false,
    launch_ready: false,
    status: 'unhealthy',
    message: 'Tenant feed status unavailable',
    supported_instruments: []
  },
  supported_instruments: [],
  subscription: {
    status: 'active',
    grace_until: null
  },
  domains: [],
  features: {
    paid_challenges: false,
    custom_domains: true,
    tenant_billing: true,
    shared_price_feed_enabled: true,
    allow_custom_mt5_feed: false
  },
  brand: {
    short_name: 'PropFirm',
    tagline: 'Free funded trading accounts with transparent rules.',
    hero_title: 'PropFirm | Free Funded Trading Accounts',
    hero_subtitle: 'Transparent rules, real progression, and white-label-ready infrastructure.',
    primary_color: '#2563eb',
    accent_color: '#0ea5e9'
  }
}

const BrandingContext = createContext({
  tenant: defaultTenant,
  loading: true
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

export function BrandingProvider({ children }) {
  const [tenant, setTenant] = useState(defaultTenant)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const slug = getTenantSlug()
    if (slug) {
      axios.defaults.headers.common['X-Tenant-Slug'] = slug
    } else {
      delete axios.defaults.headers.common['X-Tenant-Slug']
    }
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    axios.get(`${API_URL}/api/tenant/config`, {
      withCredentials: true,
      headers: getTenantHeaders()
    })
      .then((response) => {
        if (!active) return
        setTenant(response.data?.tenant || defaultTenant)
      })
      .catch(() => {
        if (!active) return
        setTenant(defaultTenant)
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const primary = tenant?.brand?.primary_color || defaultTenant.brand.primary_color
    const accent = tenant?.brand?.accent_color || defaultTenant.brand.accent_color
    const primaryRgb = hexToRgb(primary)
    const accentRgb = hexToRgb(accent)

    document.documentElement.style.setProperty('--brand-primary', primary)
    document.documentElement.style.setProperty('--brand-primary-strong', primary)
    document.documentElement.style.setProperty('--brand-primary-rgb', primaryRgb ? `${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}` : '37, 99, 235')
    document.documentElement.style.setProperty('--brand-primary-glow', primaryRgb ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.28)` : 'rgba(37,99,235,0.28)')
    document.documentElement.style.setProperty('--brand-primary-soft', primaryRgb ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.12)` : 'rgba(37,99,235,0.12)')
    document.documentElement.style.setProperty('--brand-accent', accent)
    document.documentElement.style.setProperty('--brand-accent-strong', accent)
    document.documentElement.style.setProperty('--brand-accent-rgb', accentRgb ? `${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}` : '14, 165, 233')
    document.documentElement.style.setProperty('--brand-accent-glow', accentRgb ? `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.24)` : 'rgba(14,165,233,0.24)')
    document.documentElement.style.setProperty('--brand-accent-soft', accentRgb ? `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.12)` : 'rgba(14,165,233,0.12)')
    document.documentElement.style.setProperty('--accent', primary)
    document.documentElement.style.setProperty('--accent-hover', primary)
    document.documentElement.style.setProperty('--accent-glow', primaryRgb ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.28)` : 'rgba(37,99,235,0.28)')
    document.documentElement.style.setProperty('--info', accent)
    document.documentElement.style.setProperty('--info-bg', accentRgb ? `rgba(${accentRgb.r}, ${accentRgb.g}, ${accentRgb.b}, 0.12)` : 'rgba(14,165,233,0.12)')
    document.documentElement.style.setProperty('--admin-accent', primary)
    document.documentElement.style.setProperty('--admin-accent-hover', primary)
    document.documentElement.style.setProperty('--admin-accent-glow', primaryRgb ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.28)` : 'rgba(37,99,235,0.28)')
    document.documentElement.style.setProperty('--admin-accent-bg', primaryRgb ? `rgba(${primaryRgb.r}, ${primaryRgb.g}, ${primaryRgb.b}, 0.12)` : 'rgba(37,99,235,0.12)')
  }, [tenant])

  const value = useMemo(() => ({ tenant, loading }), [tenant, loading])

  return (
    <BrandingContext.Provider value={value}>
      {children}
    </BrandingContext.Provider>
  )
}

export function useBranding() {
  return useContext(BrandingContext)
}
