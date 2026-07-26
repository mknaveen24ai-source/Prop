import React from 'react'

/**
 * Ledger Desk card primitive — a flat, hairline-bordered surface.
 * Optional editorial header: an eyebrow (small-caps mono kicker), a serif
 * title, and a right-aligned actions slot.
 *
 * ruled: add the double-rule top border (broadsheet masthead treatment)
 * flush: remove interior padding (for tables/lists that manage their own)
 */
export default function Card({
  eyebrow,
  title,
  actions,
  ruled = false,
  flush = false,
  className = '',
  children,
  ...rest
}) {
  const classes = [
    'lx-card',
    ruled ? 'lx-card--ruled' : '',
    flush ? 'lx-card--flush' : '',
    className,
  ].filter(Boolean).join(' ')

  const hasHead = eyebrow || title || actions

  return (
    <div className={classes} {...rest}>
      {hasHead && (
        <div className="lx-card__head">
          <div>
            {eyebrow && <div className="lx-card__eyebrow">{eyebrow}</div>}
            {title && <h3 className="lx-card__title">{title}</h3>}
          </div>
          {actions && <div className="lx-card__actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  )
}
