import React from 'react'
import './skeleton.css'

/**
 * Loading placeholders that match the shape of the content they stand in for.
 *
 * A bare "Loading..." collapses the layout and then reflows everything when
 * data lands; a skeleton of the right size holds the space, so the page does
 * not jump under the reader.
 *
 * Generalised from the .admin-skeleton shimmer already in admin.css so the
 * trader-facing pages and the admin pages animate identically rather than
 * drifting into two loading looks.
 *
 * Respects prefers-reduced-motion — the shimmer is decorative and stops for
 * anyone who has asked for less movement (see skeleton.css).
 */

function baseStyle({ width, height, radius, style }) {
  return {
    width: width || '100%',
    height: height || '1em',
    borderRadius: radius ?? 2,
    ...style
  }
}

/** A single bar. The building block for everything else. */
export function SkeletonLine({ width, height, radius, style, className = '' }) {
  return (
    <span
      className={`ui-skeleton ${className}`.trim()}
      style={baseStyle({ width, height, radius, style })}
      aria-hidden="true"
    />
  )
}

/** Several lines of text. The last is shortened so it reads as a paragraph. */
export function SkeletonText({ lines = 3, width = '100%', gap = 8, style }) {
  return (
    <span className="ui-skeleton-stack" style={{ gap, ...style }} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <SkeletonLine key={i} width={i === lines - 1 ? '60%' : width} height="0.85em" />
      ))}
    </span>
  )
}

/** Card-shaped placeholder: a title, some body lines, and an optional figure. */
export function SkeletonCard({ lines = 3, showTitle = true, height, style }) {
  return (
    <div className="ui-skeleton-card" style={{ height, ...style }} aria-hidden="true">
      {showTitle ? <SkeletonLine width="45%" height="1.1em" style={{ marginBottom: 14 }} /> : null}
      <SkeletonText lines={lines} />
    </div>
  )
}

/** A grid of stat tiles, matching the dashboard's summary row. */
export function SkeletonStats({ count = 4, style }) {
  return (
    <div className="ui-skeleton-stats" style={style} aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="ui-skeleton-card">
          <SkeletonLine width="55%" height="0.75em" style={{ marginBottom: 10 }} />
          <SkeletonLine width="80%" height="1.6em" />
        </div>
      ))}
    </div>
  )
}

/** Ghost table. Column widths vary so it does not read as a solid block. */
export function SkeletonTable({ rows = 6, columns = 5, showHeader = true, style }) {
  const widths = ['22%', '18%', '26%', '16%', '18%', '20%', '14%']
  return (
    <div className="ui-skeleton-table" style={style} aria-hidden="true">
      {showHeader ? (
        <div className="ui-skeleton-row ui-skeleton-row--header">
          {Array.from({ length: columns }).map((_, c) => (
            <SkeletonLine key={c} width={widths[c % widths.length]} height="0.7em" />
          ))}
        </div>
      ) : null}
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="ui-skeleton-row">
          {Array.from({ length: columns }).map((_, c) => (
            <SkeletonLine key={c} width={widths[(c + r) % widths.length]} height="0.85em" />
          ))}
        </div>
      ))}
    </div>
  )
}

/**
 * Wrapper for the common case. Announces loading to assistive tech once,
 * rather than leaving a purely visual placeholder that screen readers skip.
 */
export default function Skeleton({ loading, children, fallback, label = 'Loading' }) {
  if (!loading) return children
  return (
    <div role="status" aria-live="polite" aria-busy="true">
      <span className="ui-skeleton-srlabel">{label}</span>
      {fallback || <SkeletonCard />}
    </div>
  )
}
