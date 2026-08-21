/**
 * Props that make a non-button element genuinely operable from the keyboard.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * The app had 2 `tabIndex` and 11 `onKeyDown` in ~37k lines, against 11
 * elements — `<tr>`, `<div>`, `<span>` — carrying an `onClick`. Every one of
 * those was mouse-only: not reachable by Tab, not activatable by Enter or
 * Space. That is WCAG 2.1.1 (Keyboard), level A, and it is the single largest
 * accessibility gap in the codebase.
 *
 * A real `<button>` is always the better answer and should be used wherever the
 * layout allows it. It does not allow it for a table row: a `<button>` cannot
 * wrap `<tr>`, and putting one inside every cell changes the tab order from one
 * stop per row to one per cell. For those cases this supplies the four things
 * the browser gives a button for free.
 *
 * ── Space vs Enter ───────────────────────────────────────────────────────────
 *
 * Both activate a button, and both are handled. Space is preventDefault'ed
 * because its default action is to scroll the page — without that, activating a
 * row also jumps the viewport a screen down.
 *
 * Enter fires on keydown and Space on keyup for a native button. Both are taken
 * on keydown here for simplicity; the difference is only observable if the
 * handler is slow enough to matter, and treating them alike is what every
 * component library does.
 *
 * @param {(event: KeyboardEvent|MouseEvent) => void} onActivate
 * @param {object} [options]
 * @param {string} [options.role='button'] Override for list/tab semantics.
 * @param {boolean} [options.disabled=false] Drops it out of the tab order.
 * @returns {object} Spread onto the element.
 */
export function interactiveProps(onActivate, options = {}) {
  const { role = 'button', disabled = false } = options

  if (disabled) {
    return { role, 'aria-disabled': true }
  }

  return {
    role,
    tabIndex: 0,
    onClick: onActivate,
    onKeyDown(event) {
      // Let key presses aimed at a real control inside the row through —
      // otherwise Space on a nested checkbox both toggles the checkbox and
      // activates the row, and Enter in a filter input opens a detail drawer.
      if (event.target !== event.currentTarget) {
        const tag = event.target.tagName
        if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'A') return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        onActivate(event)
      } else if (event.key === ' ' || event.key === 'Spacebar') {
        // Space scrolls the page by default; activating a row must not also
        // scroll it.
        event.preventDefault()
        onActivate(event)
      }
    },
  }
}

/**
 * `interactiveProps` for a clickable table row.
 *
 * Separate only so the intent reads at the call site, and so the role stays
 * correct: a `<tr>` inside a real `<table>` must keep its implicit `row` role
 * or the table's structure is lost to a screen reader — announcing "button"
 * where a row belongs breaks row/column navigation entirely.
 *
 * @param {(event: KeyboardEvent|MouseEvent) => void} onActivate
 * @param {object} [options]
 * @returns {object} Spread onto the `<tr>`.
 */
export function rowInteractionProps(onActivate, options = {}) {
  const props = interactiveProps(onActivate, { ...options, role: undefined })
  // role is deliberately dropped: `<tr>` keeps its native `row` role.
  delete props.role
  return props
}
