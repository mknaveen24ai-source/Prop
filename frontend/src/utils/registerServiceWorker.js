/**
 * Service-worker registration.
 *
 * Deliberately quiet about failure. A worker that will not register costs the
 * user an offline shell and installability -- it does not stop the app working,
 * so nothing here may throw into the app's startup path.
 *
 * Dev is excluded: `offlineShellPlugin` only runs on build, so there is no
 * /sw.js to register, and a worker caching modules fights HMR.
 */

const SW_URL = '/sw.js'

/**
 * @param {(registration: ServiceWorkerRegistration) => void} [onUpdateReady]
 *   Called when a NEW worker has installed while an old one is controlling the
 *   page -- i.e. a deploy landed under a tab that is still open.
 */
export function registerServiceWorker(onUpdateReady) {
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  if (import.meta.env && import.meta.env.DEV) return

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(SW_URL)
      .then((registration) => {
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return

          installing.addEventListener('statechange', () => {
            // `controller` is null on the very first visit; an install with no
            // controller is the initial one, not an update, and telling a
            // first-time visitor that a new version is ready would be noise.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              if (typeof onUpdateReady === 'function') onUpdateReady(registration)
            }
          })
        })
      })
      .catch(() => {
        // Registration is blocked in some embedded browsers and by some
        // enterprise policies. Nothing to recover; the app runs unchanged.
      })
  })
}

/** Ask a waiting worker to take over, then reload once it does. */
export function applyServiceWorkerUpdate(registration) {
  const waiting = registration && registration.waiting
  if (!waiting) {
    window.location.reload()
    return
  }

  // Reload only after the new worker actually controls the page, otherwise the
  // reload races activation and can land on the old shell again.
  let reloaded = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return
    reloaded = true
    window.location.reload()
  })

  waiting.postMessage('SKIP_WAITING')
}
