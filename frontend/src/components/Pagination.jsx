import React from 'react'
import { motion } from 'framer-motion'
import { ChevronLeft, ChevronRight } from 'lucide-react'

/**
 * Reusable Pagination component.
 *
 * Props:
 *  - page        {number}   Current page (1-indexed)
 *  - totalPages  {number}   Total number of pages
 *  - onPageChange {Function} Callback receives new page number
 *  - pageSize    {number}   Optional — items per page (used for label only)
 *  - total       {number}   Optional — total item count (used for label)
 */
export default function Pagination({ page, totalPages, onPageChange, pageSize, total }) {
  if (!totalPages || totalPages <= 1) return null

  const canPrev = page > 1
  const canNext = page < totalPages

  // Build page number window: always show first, last, and up to 3 around current
  const getPages = () => {
    const pages = []
    const delta = 1
    for (let i = 1; i <= totalPages; i++) {
      if (
        i === 1 ||
        i === totalPages ||
        (i >= page - delta && i <= page + delta)
      ) {
        pages.push(i)
      } else if (pages[pages.length - 1] !== '...') {
        pages.push('...')
      }
    }
    return pages
  }

  const btnStyle = (isActive, isDisabled) => ({
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '34px',
    height: '34px',
    padding: '0 8px',
    border: isActive
      ? '1px solid var(--accent)'
      : '1px solid var(--border)',
    background: isActive
      ? 'var(--accent)'
      : 'var(--bg-surface)',
    color: isActive
      ? 'var(--paper)'
      : isDisabled
        ? 'var(--text-muted)'
        : 'var(--text-secondary)',
    cursor: isDisabled ? 'not-allowed' : 'pointer',
    fontSize: 'var(--fs-base)',
    fontWeight: isActive ? 700 : 500,
    opacity: isDisabled ? 0.5 : 1,
    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
    userSelect: 'none',
  })

  const totalShown = total != null && pageSize != null
    ? `Showing ${Math.min((page - 1) * pageSize + 1, total)}–${Math.min(page * pageSize, total)} of ${total}`
    : `Page ${page} of ${totalPages}`

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 'var(--space-3)',
      padding: '12px 0',
      flexWrap: 'wrap',
    }}>
      <span style={{ fontSize: 'var(--fs-sm)', color: 'var(--text-muted)', fontWeight: 500 }}>
        {totalShown}
      </span>

      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        {/* Prev */}
        <motion.button
          whileHover={canPrev ? { scale: 1.05 } : {}}
          whileTap={canPrev ? { scale: 0.95 } : {}}
          style={btnStyle(false, !canPrev)}
          onClick={() => canPrev && onPageChange(page - 1)}
          aria-label="Previous page"
          disabled={!canPrev}
        >
          <ChevronLeft size={15} />
        </motion.button>

        {/* Page numbers */}
        {getPages().map((p, i) =>
          p === '...' ? (
            <span key={`ellipsis-${i}`} style={{ color: 'var(--text-muted)', fontSize: 'var(--fs-base)', padding: '0 4px' }}>
              …
            </span>
          ) : (
            <motion.button
              key={p}
              whileHover={p !== page ? { scale: 1.05 } : {}}
              whileTap={p !== page ? { scale: 0.95 } : {}}
              style={btnStyle(p === page, false)}
              onClick={() => p !== page && onPageChange(p)}
              aria-label={`Page ${p}`}
              aria-current={p === page ? 'page' : undefined}
            >
              {p}
            </motion.button>
          )
        )}

        {/* Next */}
        <motion.button
          whileHover={canNext ? { scale: 1.05 } : {}}
          whileTap={canNext ? { scale: 0.95 } : {}}
          style={btnStyle(false, !canNext)}
          onClick={() => canNext && onPageChange(page + 1)}
          aria-label="Next page"
          disabled={!canNext}
        >
          <ChevronRight size={15} />
        </motion.button>
      </div>
    </div>
  )
}
