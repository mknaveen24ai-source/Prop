import { useEffect } from 'react'

/**
 * Freeze the page behind an open overlay.
 *
 * Two things this does that the ad-hoc `document.body.style.overflow = 'hidden'`
 * pattern elsewhere in the app gets wrong:
 *
 *  1. It restores the *previous* value rather than hard-coding `'auto'`, so
 *     nested overlays (a sheet opened from a drawer) unwind correctly instead of
 *     the inner one unlocking the page for both.
 *  2. It compensates for the scrollbar's width on desktop, so locking does not
 *     shift the whole layout sideways by ~15px.
 *
 * iOS Safari ignores `overflow: hidden` on <body> for touch scrolling, so the
 * position is pinned too and restored on unlock.
 */
export default function useBodyScrollLock(active) {
  useEffect(() => {
    if (!active || typeof document === 'undefined') return undefined

    const { body, documentElement } = document
    const previous = {
      overflow: body.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      paddingRight: body.style.paddingRight,
    }
    const scrollY = window.scrollY

    const scrollbarWidth = window.innerWidth - documentElement.clientWidth
    if (scrollbarWidth > 0) {
      const existing = parseFloat(window.getComputedStyle(body).paddingRight) || 0
      body.style.paddingRight = `${existing + scrollbarWidth}px`
    }

    body.style.overflow = 'hidden'
    body.style.position = 'fixed'
    body.style.top = `-${scrollY}px`
    body.style.width = '100%'

    return () => {
      body.style.overflow = previous.overflow
      body.style.position = previous.position
      body.style.top = previous.top
      body.style.width = previous.width
      body.style.paddingRight = previous.paddingRight
      window.scrollTo(0, scrollY)
    }
  }, [active])
}
