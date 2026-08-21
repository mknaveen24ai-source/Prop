import { Sentry } from './utils/sentry'

/**
 * Core Web Vitals reporting.
 *
 * ── What was wrong ───────────────────────────────────────────────────────────
 *
 * The previous version was Create React App's scaffold, unchanged:
 *
 *     const reportWebVitals = onPerfEntry => {
 *       if (onPerfEntry && onPerfEntry instanceof Function) { … }
 *     }
 *
 * and index.jsx called it as `reportWebVitals()` — with no argument. The guard
 * was therefore always false, the dynamic `import('web-vitals')` never ran, and
 * nothing was ever measured. It had been dead code for the life of the project
 * while looking, in the import list, exactly like working instrumentation.
 *
 * It was also pinned to web-vitals 2, whose API is `getCLS`/`getFID`. FID was
 * retired from Core Web Vitals in March 2024 and replaced by INP, which v2
 * cannot measure at all — so even had it run, it would have been reporting a
 * metric nobody uses and missing the one that replaced it.
 *
 * ── Thresholds ───────────────────────────────────────────────────────────────
 *
 * These are Google's published "good" boundaries, not invented targets:
 *   LCP  ≤ 2500ms      INP ≤ 200ms      CLS ≤ 0.1
 *   FCP  ≤ 1800ms      TTFB ≤ 800ms
 *
 * A separate, tighter internal budget is asserted in CI (see the Lighthouse
 * step). This file reports what real users experience; CI asserts what the
 * build is allowed to ship.
 */

/** Google's "good" upper bound per metric. */
const GOOD = {
  LCP: 2500,
  INP: 200,
  CLS: 0.1,
  FCP: 1800,
  TTFB: 800,
}

/**
 * Send one metric to Sentry as a measurement on the active transaction, and
 * leave a breadcrumb so a slow session can be read in order.
 *
 * Sentry rather than a new endpoint: it is already initialised, already has the
 * session and release attached, and adding a bespoke analytics sink for five
 * numbers would be a second thing to operate.
 */
function report(metric) {
  const { name, value, rating } = metric
  const budget = GOOD[name]

  Sentry.setMeasurement?.(
    `webvital.${name.toLowerCase()}`,
    value,
    name === 'CLS' ? 'none' : 'millisecond'
  )

  Sentry.addBreadcrumb?.({
    category: 'web-vital',
    level: budget != null && value > budget ? 'warning' : 'info',
    message: `${name} ${name === 'CLS' ? value.toFixed(3) : Math.round(value) + 'ms'} (${rating})`,
    data: { name, value, rating, budget },
  })
}

/**
 * Start reporting.
 *
 * @param {(metric: object) => void} [onPerfEntry] Optional extra sink, for a
 *   test or a local `reportWebVitals(console.log)`. Reporting to Sentry happens
 *   either way — that is the fix for the original bug, where omitting this
 *   argument silently disabled everything.
 */
export default function reportWebVitals(onPerfEntry) {
  const handle = (metric) => {
    report(metric)
    if (typeof onPerfEntry === 'function') onPerfEntry(metric)
  }

  // Still dynamically imported: these listeners are not needed for first paint,
  // and keeping the library off the entry chunk is the reason the original was
  // written this way.
  import('web-vitals')
    .then(({ onCLS, onINP, onLCP, onFCP, onTTFB }) => {
      onCLS(handle)
      onINP(handle)
      onLCP(handle)
      onFCP(handle)
      onTTFB(handle)
    })
    .catch(() => {
      // Never let instrumentation break the app. A failed chunk fetch here
      // means no metrics, not a blank page.
    })
}
