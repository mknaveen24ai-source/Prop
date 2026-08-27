const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

function extractHostname(input: unknown): string {
  if (!input) return ''
  const raw = String(input).trim()
  if (!raw) return ''

  try {
    const parsed = raw.includes('://') ? new URL(raw) : new URL(`http://${raw}`)
    return String(parsed.hostname || '').trim().toLowerCase()
  } catch {
    return (raw.split(':')[0] ?? '').trim().toLowerCase()
  }
}

function isLocalHostname(hostname: unknown): boolean {
  return LOCAL_HOSTS.has(String(hostname || '').trim().toLowerCase())
}

function getConfiguredAllowedHostnames(): Set<string> {
  const configured = [
    process.env.FRONTEND_URL,
    ...String(process.env.ALLOWED_ORIGINS || '').split(',')
  ]
    .map((value) => extractHostname(value))
    .filter(Boolean)
  return new Set(configured)
}

// Single-tenant CORS allowlist: same origin (no Origin header), localhost,
// and whatever hostnames are configured via FRONTEND_URL / ALLOWED_ORIGINS.
function isAllowedOrigin(origin: unknown): boolean {
  if (!origin) return true
  const hostname = extractHostname(origin)
  if (!hostname || isLocalHostname(hostname)) return true
  return getConfiguredAllowedHostnames().has(hostname)
}

export {
  isAllowedOrigin
}
