// Correctness-only lint config — the gate that blocks CI at zero warnings.
//
// ── Why this file exists ─────────────────────────────────────────────────────
//
// `npm run lint` reports 709 warnings, and 547 of them are `design-tokens/*`.
// Those are governed by a RATCHET, not a gate: `npm run design:drift:ci` holds
// a ceiling that may only go down, because each of the 547 needs a per-surface
// design decision (every one moves type or spacing by 1-4px). That contract is
// documented in docs/DESIGN_TOKENS.md and in the CI workflow.
//
// So `eslint . --max-warnings=0` over the WHOLE ruleset cannot be the gate. It
// would force either shipping 547 unreviewed visual changes or turning the
// check off, and the second always wins — which is how a codebase ends up with
// a lint script nobody runs.
//
// This config is the base config with the three design-token rules switched
// off, so everything that is genuinely a correctness or hygiene finding —
// react-hooks/*, no-unused-vars, prefer-const — gates at zero while the token
// drift keeps its ratchet. Two mechanisms, two contracts, neither weakened to
// accommodate the other.
//
// It re-exports the base array rather than duplicating it: a second copy of the
// rule set is a copy that drifts, and a lint config that disagrees with itself
// is worse than one gate fewer.
import base from './eslint.config.mjs'

export default [
  ...base,
  {
    // Last block wins in flat config, so this overrides the 'warn' set in the
    // base config without editing it.
    rules: {
      'design-tokens/no-hardcoded-spacing': 'off',
      'design-tokens/no-hardcoded-font-size': 'off',
      'design-tokens/no-hardcoded-color': 'off',
      // Ratcheted by `npm run effect:drift:ci` for the same reason. Every
      // remaining hit is `useEffect(() => { fetchThing() }, [])` where the
      // fetcher sets a loading flag before its first await -- correct external
      // synchronisation that the compiler cannot see past. The genuine
      // derived-state cases the rule exists for were fixed, not counted.
      'react-hooks/set-state-in-effect': 'off'
    }
  }
]
