import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { PUBLIC_ROUTES, SITE_NAME, findPublicRoute } from '../config/publicRoutes'

/**
 * Per-route <title>, description and canonical for the public pages.
 *
 * One static <head> served every route, so /rules, /transparency and the legal
 * pages all shared the landing page's title and description — a search result
 * for any of them was indistinguishable from a search result for the others.
 *
 * Deliberately not react-helmet-async: this needs to set four tags on nine
 * routes, and that is about forty lines against a dependency (plus a provider
 * wrapping the tree) in a money-handling frontend whose bundle is already the
 * landing page's slowest asset.
 *
 * Only public routes are touched. Inside /dashboard and /admin the tags are
 * left exactly as index.html shipped them: those pages are noindex by
 * robots.txt and their titles are not a ranking surface.
 */

function upsertMeta(selector, attrs) {
  let el = document.head.querySelector(selector)
  if (!el) {
    el = document.createElement('meta')
    for (const [key, value] of Object.entries(attrs)) {
      if (key !== 'content') el.setAttribute(key, value)
    }
    document.head.appendChild(el)
  }
  el.setAttribute('content', attrs.content)
  return el
}

function upsertCanonical(href) {
  let el = document.head.querySelector('link[rel="canonical"]')
  if (!href) {
    if (el) el.remove()
    return
  }
  if (!el) {
    el = document.createElement('link')
    el.setAttribute('rel', 'canonical')
    document.head.appendChild(el)
  }
  el.setAttribute('href', href)
}

export default function useDocumentMeta() {
  const { pathname } = useLocation()

  useEffect(() => {
    const route = findPublicRoute(pathname)
    if (!route) return

    document.title = route.title
    upsertMeta('meta[name="description"]', { name: 'description', content: route.description })
    upsertMeta('meta[property="og:title"]', { property: 'og:title', content: route.title })
    upsertMeta('meta[property="og:description"]', { property: 'og:description', content: route.description })
    upsertMeta('meta[name="twitter:title"]', { name: 'twitter:title', content: route.title })
    upsertMeta('meta[name="twitter:description"]', { name: 'twitter:description', content: route.description })

    // The canonical origin is only known at build time (see vite.config.mjs).
    // Without it a canonical would have to be relative, which is meaningless —
    // so the tag is simply absent rather than wrong.
    const origin = document.head.querySelector('meta[name="site-origin"]')?.content || ''
    upsertCanonical(origin ? `${origin}${route.path === '/' ? '' : route.path}` : null)
  }, [pathname])
}

/** Exported for the sitemap test — keeps the route table honest. */
export { PUBLIC_ROUTES, SITE_NAME }
