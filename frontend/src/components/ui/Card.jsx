import React from 'react'

/**
 * Ledger Desk card primitive — a translucent glass surface with a whisper
 * shadow (see --elev in tokens.css). Optional editorial header: an eyebrow
 * (small-caps mono kicker), a serif title, and a right-aligned actions slot.
 *
 * ruled: masthead treatment — the card header gets a 3px double-rule
 *       bottom border instead of the default 1px hairline
 * flush: remove interior padding (for tables/lists that manage their own)
 * stat: tighter density + a 2px tone bar along the top edge (use `tone`
 *       to set its color, e.g. tone="var(--gain)")
 * interactive: cursor:pointer + a stronger hover lift, for cards that drill
 *       through to a detail view
 */
export default function Card({
  eyebrow,
  title,
  actions,
  ruled = false,
  flush = false,
  stat = false,
  interactive = false,
  tone,
  className = '',
  style,
  children,
  ...rest
}) {
  const classes = [
    'lx-card',
    ruled ? 'lx-card--ruled' : '',
    flush ? 'lx-card--flush' : '',
    stat ? 'lx-card--stat' : '',
    interactive ? 'lx-card--interactive' : '',
    className,
  ].filter(Boolean).join(' ')

  const hasHead = eyebrow || title || actions
  const mergedStyle = tone ? { '--tone': tone, ...style } : style

  return (
    <div className={classes} style={mergedStyle} {...rest}>
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
