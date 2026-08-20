# Design tokens — the scales, the checkers, and what "done" means

Branch `ui/consistency-2026-08-20`, 10 commits, 140 files.

---

## What the brief got wrong

This work started from a roadmap that put UI consistency at "74%" and asked for
100%. Its direction was right — there is real drift, and the design system to fix
it already existed. Its specifics were not, and two of its instructions would
have damaged the platform.

**The spacing scale is 4-point, not 8-point.** The brief listed
`--space-3 (16px)`, `--space-4 (24px)`, `--space-6 (32px)`. The real values are
**12px, 16px and 24px**. Migrating with that mapping would have shrunk padding by
one step everywhere it was applied.

**Body copy is Source Serif 4, not Inter.** Inter is not loaded anywhere. The
editorial serif is the identity the brief's own opening line praises; repointing
`--font-ui` to Inter would have replaced the platform's look wholesale.

**Two deliverables already existed.** `SkeletonCard` and `SkeletonTable` were
already in `components/ui/Skeleton.jsx`, and `AdminDataTable` / `AdminModal` /
`AdminBadge` in `components/admin/`. The gap was adoption, not creation.

**The central premise did not hold.** The brief described "thousands of raw
inline style objects (`style={{ background: '#1c1917' }}`)". The whole frontend
contained **63 hex literals**, and 1,423 inline styles already used
`var(--token)`. Colour was largely solved. The drift was dimensional.

**And the largest real gap was not mentioned: there was no font-size scale at
all.** `tokens.css` defined spacing, radii, font families and text *colours* —
nothing for size. Hence 30 distinct sizes hardcoded across the JSX, including
9.5px, 10.5px, 11.5px, 12.5px and 13.5px. You cannot migrate to a token that does
not exist.

Smaller corrections: Dashboard.jsx is 594 lines not 1,162; TradingPanel.jsx 850
not 1,182; admin.css 1,477 not 1,327; 35 admin views not 38; 59 routes not 41.
Neither named file is in the top ten for inline styles — `Analytics.jsx` (216)
and `DashboardHome.jsx` (102) are.

---

## The scales

Both live in `src/styles/tokens.css`. **Both checkers read them from there.**
Neither carries its own copy, because a checker with a private copy can be wrong
in exactly the way the brief was wrong while still reporting full marks.

### Spacing — 4-point, with half-steps

```
--space-1   4px      --space-6   24px
--space-2   8px      --space-7   32px
--space-3  12px      --space-8   40px
--space-4  16px      --space-9   48px
--space-5  20px      --space-10  64px

--space-1-5  6px     --space-3-5  14px
--space-2-5 10px     --space-4-5  18px
```

The half-steps are the midpoints of the main sequence and were added on evidence,
not preference: 6, 10, 14 and 18px accounted for ~530 hardcoded values, `ui.css`
and `admin.css` use them, and `gap: 10px`, `padding: 8px 10px` and
`padding: 6px 8px` each repeat dozens of times across unrelated files. That is a
density decision somebody made. Snapping it to the 4-point grid would have
visibly loosened every compact control on the platform.

The 4-point steps stay primary for layout. Reaching for a half-step should read
as a deliberate choice about density, which is why they are named as fractions
rather than renumbered into the sequence.

### Type

```
--fs-3xs   9px      --fs-lg   16px      --fs-5xl  28px
--fs-2xs  10px      --fs-xl   18px      --fs-6xl  40px
--fs-xs   11px      --fs-2xl  20px      --fs-7xl  48px
--fs-sm   12px      --fs-3xl  22px
--fs-base 13px      --fs-4xl  24px
--fs-md   14px
```

Taken from the measured distribution rather than a modular ratio, so the values
already carrying the interface are exact matches and adopting a token changes
nothing on screen. 11/12/13px alone account for 621 uses; a 1.25 scale would have
moved every one and turned a token migration into an unreviewable redesign. The
top end is spaced the same way — 28px (7 uses) and 40px (3) are real, while
26/32/34/36/38px are one-offs.

Line heights ship alongside: `--leading-tight` through `--leading-relaxed`.

### Typefaces

| Token | Face | Used for |
|---|---|---|
| `--font-ui` | Source Serif 4 | body copy and labels |
| `--font-display` | Playfair Display | mastheads, headings |
| `--font-mono` | IBM Plex Mono | every figure — prices, PnL, balances, ids |

Anything in the mono face gets `font-variant-numeric: tabular-nums`, scoped to
the font rather than to a component list so the rule cannot go stale. Without it
a column of prices jitters horizontally as the last digit changes, which on a
feed updating every second reads as the table twitching.

---

## The checkers

Two of them, and **they agree site-for-site** — 365 spacing, 209 font-size, 0
colour, the same file:line in every case. Getting them to agree found four bugs
in the tooling; see the commit history.

### `npm run design:drift`

Counts violations across 160 `.jsx` and 14 `.css` files under `src/`. This is the
definition of done, replacing an unmeasurable percentage.

```
npm run design:drift            # summary
npm run design:drift -- --detail   # every occurrence with file:line
npm run design:drift:ci         # exits 1 above the ceiling
```

### ESLint rules

`design-tokens/no-hardcoded-{spacing,font-size,color}` in
`eslint-rules/design-tokens.js`, naming the nearest token in the message. They
are **warnings**, following the philosophy already in `eslint.config.mjs`: real
defects are errors and block CI, hygiene is a warning cleaned up incrementally.

### The ratchet

CI holds a ceiling, currently **753**, in the frontend job. A ceiling rather than
zero because 753 values still need a per-surface design decision — each moves
type or spacing by 1–4px. Blocking on zero would mean either shipping those
unreviewed or switching the check off, and the second always wins.

**The number may only go down.** Lower `--max` in `package.json` in the same
commit that lowers the count.

---

## Exceptions

Two mechanisms, and the narrow one is preferred.

**Inline**, next to the thing it excuses:

```js
// design-drift-allow: a QR code needs a white quiet zone to scan reliably
background: '#fff'
```

The reason is mandatory — a bare marker is ignored, because an opt-out nobody had
to justify is how a checker quietly stops checking.

**File-level**, in `design-tokens.config.js`, for files where every colour is
legitimate: `ErrorBoundary.jsx` (renders after the app has thrown, when custom
properties may never have loaded), `CertificateLayoutEditor.jsx` (hex *is* the
data), `ClusterGraph.jsx` and `deviceSignature.js` (canvas, which cannot resolve
`var()`).

A hex used as a **fallback** is not a violation and needs no marker — the token is
read first:

```js
var(--rule, #3A3733)                 getCssVar('--rule') || '#3A3733'
readToken('--rule', '#3a3a3a')
```

---

## Visual regression

Storybook covers `components/ui/` with every variant and state in both themes.
Playwright screenshots those stories, 7 × 2, **only inside
`mcr.microsoft.com/playwright:v1.62.1-noble`**.

```bash
cd frontend && npm run build-storybook
npx http-server storybook-static -p 6006 &

docker run --rm -v "$PWD:/work" -w /work/e2e \
  mcr.microsoft.com/playwright:v1.62.1-noble \
  npx playwright test --project=visual --update-snapshots
```

Outside that image the project is **skipped**, not run. Font rasterisation
differs between Windows, macOS and Linux distributions; baselines made on a
developer's machine will not match a CI runner's, and the resulting permanent red
is the most common reason screenshot suites get deleted. A skip is honest.

`@playwright/test` is pinned to exactly `1.62.1` so the package and the image tag
cannot drift apart.

Stories rather than app pages, because app pages render live balances and
timestamps — screenshotting those reports a diff every run for reasons unrelated
to design.

> **Baselines have not been generated yet.** Docker is not installed on the
> machine this work was done on, so the first run must happen in CI or on a
> machine with Docker. Until then the job has nothing to compare against.

---

## Where it stands

| | Start | Now |
|---|---:|---:|
| Hardcoded colours | 32 | **0** (3 documented exceptions) |
| Font sizes off scale | 1,082 | **209** |
| Spacing untokenised | 1,470 | **216** |
| Files scanned | 159 jsx | 160 jsx + **14 css** |
| Skeleton adoption | 3 files | **10** |
| Storybook | none | 7 stories × 2 themes |
| Visual regression | none | 14 tests, container-pinned |

The reported total went 1,975 → 546 → **753**. The rise is the counter becoming
honest about stylesheets it could not previously see, not a regression: 14 CSS
files went from unmeasured to measured, and `ui.css` — the design system's own
sheet — turned out to carry 22 hardcoded font sizes while the checker enforced
the type scale in every component that used it.

### What remains

- **209 font sizes and 328 spacing values** need a per-surface eye. Each moves
  1–4px, which is a design decision, not a codemod. `npm run design:drift --
  --detail` lists every one.
- **Admin component adoption**: `AdminDataTable` 58%, `AdminBadge` 56%,
  `AdminModal` 22%.
- **Visual baselines**, per the note above.
- **CLS is unmeasured.** The six worst offenders now render dimensioned
  skeletons, which is the mechanism that fixes it, but no before/after number
  exists. Measuring it needs a running stack and belongs with the baselines.
