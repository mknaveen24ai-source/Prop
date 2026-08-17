/**
 * Development-only horizontal-overflow detector.
 *
 * A page that scrolls sideways on a phone is always a bug in this app — wide
 * content (tables, heatmaps) is supposed to scroll inside its own container.
 * But the cause is usually one element buried in a tree of inline styles, and
 * spotting it by eye means dragging the DevTools viewport across every route.
 *
 * This walks the DOM after a route settles and reports any element wider than
 * the document, with a CSS-path-ish label you can paste into the console.
 * Tree-shaken out of production builds via the import.meta.env.DEV guard at the
 * call site in App.jsx.
 */

const SLOP_PX = 2 // sub-pixel rounding on transforms and borders

function describe(el) {
  const id = el.id ? `#${el.id}` : ''
  const cls = typeof el.className === 'string' && el.className
    ? `.${el.className.trim().split(/\s+/).slice(0, 3).join('.')}`
    : ''
  return `${el.tagName.toLowerCase()}${id}${cls}`
}

/**
 * @param {{ label?: string }} [options]
 * @returns {Array<{ element: Element, selector: string, width: number, overflowBy: number }>}
 */
export function findHorizontalOverflow(options = {}) {
  if (typeof document === 'undefined') return []

  const docWidth = document.documentElement.clientWidth
  const offenders = []

  for (const el of document.querySelectorAll('body *')) {
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue

    // Only flag elements that push past the right edge or start left of it.
    // An element inside a scroll container is the container's business.
    const overflowRight = rect.right - docWidth
    const overflowLeft = -rect.left
    const overflowBy = Math.max(overflowRight, overflowLeft)
    if (overflowBy <= SLOP_PX) continue

    // Skip anything already living inside something that scrolls horizontally
    // on purpose — that is the fix, not the bug.
    let parent = el.parentElement
    let contained = false
    while (parent && parent !== document.body) {
      const overflowX = getComputedStyle(parent).overflowX
      if (overflowX === 'auto' || overflowX === 'scroll' || overflowX === 'hidden' || overflowX === 'clip') {
        contained = true
        break
      }
      parent = parent.parentElement
    }
    if (contained) continue

    // Fixed/absolute decoration (background orbs, scrims) is positioned
    // deliberately and does not create a scrollbar when the body clips.
    const position = getComputedStyle(el).position
    if (position === 'fixed') continue

    offenders.push({
      element: el,
      selector: describe(el),
      width: Math.round(rect.width),
      overflowBy: Math.round(overflowBy),
    })
  }

  // One wide container drags every descendant past the edge with it, so a raw
  // list is mostly noise — a single bad grid reported as 370 findings. Only the
  // outermost offender in each subtree is actionable; fix it and the rest go.
  const elements = new Set(offenders.map((o) => o.element))
  const roots = offenders.filter((o) => {
    let p = o.element.parentElement
    while (p && p !== document.body) {
      if (elements.has(p)) return false
      p = p.parentElement
    }
    return true
  })

  if (roots.length > 0) {
    const where = options.label ? ` on ${options.label}` : ''
    // console.table renders as a readable grid; the raw nodes go alongside it so
    // they stay inspectable/hoverable in DevTools.
    console.warn(
      `[overflow-guard] ${roots.length} container(s) exceed the ${docWidth}px viewport${where} ` +
      `(${offenders.length} elements total, ${offenders.length - roots.length} of them just inherited it). ` +
      'Wide content should scroll inside its own container, not the page.'
    )
    console.table(roots.map((o) => ({
      selector: o.selector,
      width: o.width,
      overflowBy: o.overflowBy,
      path: pathOf(o.element),
    })))
    console.warn('[overflow-guard] nodes:', roots.map((o) => o.element))
  }

  return roots
}

/** Shallow DOM path, enough to find the element in a large tree. */
function pathOf(el) {
  const parts = []
  let n = el
  while (n && n !== document.body && parts.length < 6) {
    parts.unshift(describe(n))
    n = n.parentElement
  }
  return parts.join(' > ')
}

export default findHorizontalOverflow
