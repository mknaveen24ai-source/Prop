/**
 * ESLint plugin: design-token drift, caught at authoring time.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `scripts/design-drift.js` counts drift across the repo and holds a ceiling in
 * CI. This catches the same thing one file at a time, in the editor, before it
 * is written down -- which is the difference between a cleanup that holds and
 * one that has to be repeated next year.
 *
 * Both read their scales from styles/tokens.css. Neither carries its own copy,
 * because a checker with a private copy of the scale can be wrong in exactly the
 * way the brief behind this work was wrong -- it called --space-3 16px when it
 * is 12px -- while still reporting full marks.
 *
 * Registered as warnings, following the philosophy already stated in
 * eslint.config.mjs: real defects are errors and block CI, hygiene is a warning
 * and cleaned up incrementally. Drift is hygiene. The ratchet in CI is what
 * stops it growing.
 */

const fs = require('fs')
const path = require('path')

// Same allowlist and suppression marker the drift script uses. Kept in one file
// on purpose: when the two checkers held separate lists they promptly disagreed,
// reporting 0 and 10 hardcoded colours for the same codebase.
const { isColorAllowlisted, SUPPRESSION_PATTERN } = require('../design-tokens.config.js')

const TOKENS = path.join(__dirname, '..', 'src', 'styles', 'tokens.css')

/** px -> token name, read once at rule-load. */
function readScale(prefix) {
  const map = new Map()
  let css
  try {
    css = fs.readFileSync(TOKENS, 'utf8')
  } catch {
    return map
  }
  const re = new RegExp('--(' + prefix + '-[a-z0-9-]+):' + '\\s*([0-9.]+)px', 'gi')
  let m
  while ((m = re.exec(css))) map.set(parseFloat(m[2]), m[1])
  return map
}

const SPACE_SCALE = readScale('space')
const FONT_SCALE = readScale('fs')

const SPACING_PROPS = /^(padding|margin|gap|rowGap|columnGap)([A-Z][a-zA-Z]*)?$/

/** Nearest token to a value, for a suggestion that is worth reading. */
function nearest(scale, px) {
  if (scale.size === 0) return null
  const best = [...scale.keys()].reduce((a, b) => (Math.abs(b - px) < Math.abs(a - px) ? b : a))
  return { px: best, token: scale.get(best), exact: best === px }
}

/** True when this node sits under an inline `style={{ ... }}` prop. */
function insideStyleProp(node) {
  let current = node
  while (current) {
    if (
      current.type === 'JSXAttribute' &&
      current.name &&
      current.name.name === 'style'
    ) return true
    current = current.parent
  }
  return false
}

const noHardcodedSpacing = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Use --space-* tokens for inline spacing values' },
    schema: []
  },
  create(context) {
    return {
      Property(node) {
        if (node.computed) return
        const name = node.key.name || node.key.value
        if (typeof name !== 'string' || !SPACING_PROPS.test(name)) return
        if (node.value.type !== 'Literal' || typeof node.value.value !== 'string') return
        if (!insideStyleProp(node)) return

        const parts = node.value.value.trim().match(/[0-9.]+px/g)
        if (!parts) return

        for (const part of parts) {
          const px = parseFloat(part)
          // 0 is "none" and 1px is a hairline rule; neither is a spacing step.
          if (px === 0 || px === 1) continue
          const token = SPACE_SCALE.get(px)
          if (token) {
            context.report({
              node,
              message: `${part} is on the spacing scale — use var(--${token}) so it follows the scale if it moves.`
            })
          } else {
            const near = nearest(SPACE_SCALE, px)
            context.report({
              node,
              message: near
                ? `${part} is off the spacing scale. Nearest is var(--${near.token}) (${near.px}px). Pick one, or add a step if this density is deliberate.`
                : `${part} is off the spacing scale.`
            })
          }
        }
      }
    }
  }
}

const noHardcodedFontSize = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Use --fs-* tokens for inline font sizes' },
    schema: []
  },
  create(context) {
    return {
      Property(node) {
        if (node.computed) return
        const name = node.key.name || node.key.value
        if (name !== 'fontSize') return
        if (node.value.type !== 'Literal' || typeof node.value.value !== 'string') return
        if (!insideStyleProp(node)) return

        const m = node.value.value.trim().match(/^([0-9.]+)px$/)
        if (!m) return
        const px = parseFloat(m[1])
        const token = FONT_SCALE.get(px)
        if (token) {
          context.report({ node, message: `${m[0]} is on the type scale — use var(--${token}).` })
          return
        }
        const near = nearest(FONT_SCALE, px)
        context.report({
          node,
          message: near
            ? `${m[0]} is off the type scale. Nearest is var(--${near.token}) (${near.px}px) — a ${(near.px - px).toFixed(1)}px change, so check it looks right rather than swapping blind.`
            : `${m[0]} is off the type scale.`
        })
      }
    }
  }
}

const noHardcodedColor = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Use design tokens rather than hex colour literals' },
    schema: []
  },
  create(context) {
    const source = context.sourceCode || context.getSourceCode()
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return
        if (!/^#[0-9a-fA-F]{3,8}$/.test(node.value.trim())) return
        if (isColorAllowlisted(context.filename || context.getFilename())) return

        // A hex used as a FALLBACK is not a hardcoded colour: the token is read
        // first and this only applies when it cannot resolve. Canvas has no
        // other option, since it cannot resolve var().
        //   getCssVar('--rule') || '#3A3733'
        //   readToken('--rule', '#3a3a3a')
        const parent = node.parent
        if (parent && parent.type === 'LogicalExpression' && parent.operator === '||' && parent.right === node) return
        if (parent && parent.type === 'CallExpression') {
          const args = parent.arguments
          const first = args[0]
          if (
            args.indexOf(node) > 0 &&
            first && first.type === 'Literal' &&
            typeof first.value === 'string' &&
            first.value.startsWith('--')
          ) return
        }

        // Documented exception, same marker the drift script honours.
        const comments = source.getCommentsBefore(node)
        const line = node.loc.start.line
        const nearbyComments = source.getAllComments().filter(
          (c) => c.loc.end.line >= line - 3 && c.loc.end.line <= line
        )
        if ([...comments, ...nearbyComments].some((c) => SUPPRESSION_PATTERN.test(c.value))) return

        context.report({
          node,
          message: `Hardcoded colour ${node.value}. Use a token, or mark it "design-drift-allow: <reason>" if the surface genuinely is not themed.`
        })
      }
    }
  }
}

module.exports = {
  rules: {
    'no-hardcoded-spacing': noHardcodedSpacing,
    'no-hardcoded-font-size': noHardcodedFontSize,
    'no-hardcoded-color': noHardcodedColor
  }
}
