import { getMemoryItem, setMemoryItem } from './memoryStore'

const TENANT_KEY = 'active_tenant_slug'

function normalizeTenantSlug(value) {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
  return normalized || null
}

function getTenantSlugFromHostname() {
  if (typeof window === 'undefined') return null
  const host = String(window.location.hostname || '').trim().toLowerCase()
  if (!host || host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null

  const parts = host.split('.').filter(Boolean)
  if (parts.length >= 3) {
    return normalizeTenantSlug(parts[0])
  }

  return null
}

export function getTenantSlug() {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  const fromQuery = normalizeTenantSlug(params.get('tenant'))
  if (fromQuery) {
    setMemoryItem(TENANT_KEY, fromQuery)
    return fromQuery
  }
  const fromHostname = getTenantSlugFromHostname()
  if (fromHostname) {
    setMemoryItem(TENANT_KEY, fromHostname)
    return fromHostname
  }
  return normalizeTenantSlug(getMemoryItem(TENANT_KEY))
}

export function getTenantHeaders() {
  const slug = getTenantSlug()
  return slug ? { 'X-Tenant-Slug': slug } : {}
}

export function buildTenantPath(path) {
  if (typeof window === 'undefined') return path
  const slug = getTenantSlug()
  if (!slug) return path

  const url = new URL(path, window.location.origin)
  url.searchParams.set('tenant', slug)
  return `${url.pathname}${url.search}${url.hash}`
}
