import React from 'react'

/**
 * Ledger Desk button primitive.
 * Routes entirely through the lx-btn classes in ui.css (tokens + --space-*),
 * so it is theme-aware in both editions with no inline color/spacing.
 *
 * variant: 'primary' | 'secondary' | 'ghost' | 'danger'   (default 'primary')
 * size:    'sm' | 'md' | 'lg'                              (default 'md')
 * as:      element/component to render ('button' | 'a' | Link, default 'button')
 * full:    stretch to container width
 */
const Button = React.forwardRef(function Button(
  { variant = 'primary', size = 'md', full = false, as: As = 'button', className = '', children, ...rest },
  ref
) {
  const classes = [
    'lx-btn',
    `lx-btn--${variant}`,
    `lx-btn--${size}`,
    full ? 'lx-btn--full' : '',
    className,
  ].filter(Boolean).join(' ')

  return (
    <As ref={ref} className={classes} {...rest}>
      {children}
    </As>
  )
})

export default Button
