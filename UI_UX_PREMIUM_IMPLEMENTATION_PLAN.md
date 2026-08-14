# PropFirm Premium UI/UX Implementation Plan

## Purpose

This document is an implementation handoff for Claude Code. Improve the existing PropFirm frontend so it feels visually appealing, premium, classy, trustworthy, and easy to use while preserving all existing business logic, routes, API integrations, authentication, trading behavior, and admin functionality.

The desired visual direction is:

> Editorial financial institution + modern professional trading terminal

Think private banking, Bloomberg, Financial Times, and institutional trading desks. The interface should feel controlled, confident, quiet, and intentional rather than loud, neon, overly rounded, or overly animated.

## Project context

- Frontend: `frontend/`
- Framework: React 19, Vite, React Router, hand-written CSS
- Main theme tokens: `frontend/src/styles/tokens.css`
- Global styles: `frontend/src/App.css`, `frontend/src/index.css`
- Shared UI styles: `frontend/src/components/ui/ui.css`
- Mode styles: `frontend/src/styles/modes/public.css`, `trader.css`, `operator.css`
- Responsive styles: `frontend/src/styles/responsive.css`
- Public landing page: `frontend/src/pages/Landing.jsx` and `frontend/src/pages/landing-sections/`
- Trader shell: `frontend/src/pages/Dashboard.jsx`, `frontend/src/components/Sidebar.jsx`
- Trading terminal: `frontend/src/components/TradingPanel.jsx`, `OrderPanel.jsx`
- Admin shell: `frontend/src/pages/admin/`, `frontend/src/components/admin/`
- Theme provider: `frontend/src/ThemeContext.jsx`
- White-label branding: `frontend/src/BrandingContext.jsx`, `frontend/src/config/branding.js`

## Non-negotiable constraints

1. Do not rewrite the application from scratch.
2. Do not introduce Tailwind, MUI, Bootstrap, or another CSS framework.
3. Preserve all current routes, API calls, Socket.IO behavior, authentication, payment, KYC, trading, payout, support, and admin functionality.
4. Preserve the runtime white-label branding hook.
5. Do not remove existing features simply to simplify the UI.
6. Do not change financial calculations, risk calculations, trade submission logic, or backend contracts.
7. Prefer shared components and tokens over page-specific inline style duplication.
8. Do not use color alone to communicate risk, status, success, or failure.
9. Every interactive control must have keyboard focus, disabled, loading, and error states.
10. Respect `prefers-reduced-motion`.

## Current design problem

The project has a strong “Ledger Desk” editorial design concept, but the implementation currently mixes two visual systems:

- Editorial flat surfaces, hairline rules, serif headings, and financial-print styling.
- Legacy glassmorphism, blur, rounded cards, gradients, glow effects, and shadows.

The main inconsistency is visible in the trader experience, especially the trading terminal. The design system should feel like one coherent product across public, trader, and operator modes.

Relevant files to inspect before editing:

- `frontend/src/styles/tokens.css`
- `frontend/src/App.css`
- `frontend/src/components/ui/ui.css`
- `frontend/src/styles/responsive.css`
- `frontend/src/pages/landing-sections/LandingStyles.js`
- `frontend/src/components/Sidebar.jsx`
- `frontend/src/components/TradingPanel.jsx`
- `frontend/src/components/OrderPanel.jsx`

## Target design principles

### 1. Premium means restraint

Use whitespace, typography, alignment, borders, and hierarchy to create quality. Reduce unnecessary gradients, glows, shadows, decorative animations, and competing colors.

### 2. One visual language

Use one consistent surface system across the product:

- Warm charcoal or ivory page background
- Slightly differentiated surface background
- Subtle 1px borders
- Mostly sharp or very lightly rounded corners
- Minimal shadows
- Accent color reserved for actions and important emphasis

Do not combine a flat editorial card with a heavy glass/shadow treatment in the same visual group.

### 3. Typography creates the brand

Use the existing fonts deliberately:

- `Playfair Display` or `Cormorant Garamond`: major headings and editorial display text
- `Source Serif 4` or `Lora`: readable body and supporting text
- `IBM Plex Mono`: prices, balances, percentages, timestamps, IDs, and trading values

Do not make every small label uppercase mono. Use mono mainly for data and compact metadata. Keep normal controls readable at 13–15px.

### 4. Status must be instantly understood

Use semantic status tokens consistently:

- Success/profit: green
- Caution: amber/gold
- Danger/loss: deep red
- Critical: deep red plus explicit label/icon
- Neutral: muted ink/gray

Every risk or status indicator must include text, an icon, or a label in addition to color.

### 5. Trust is part of the UI

Do not show fake, stale, or unexplained metrics. Replace hard-coded public statistics with verified data or label them clearly as examples/demo values.

## Token system implementation

### Create or normalize semantic tokens

Keep existing token names for compatibility, but make their meaning consistent. Add semantic aliases where useful:

```css
:root {
  --surface-page: var(--paper);
  --surface-primary: var(--paper-2);
  --surface-inset: var(--paper);
  --surface-interactive: var(--paper-2);
  --border-subtle: var(--rule-soft);
  --border-default: var(--rule);
  --border-strong: var(--ink);
  --text-primary: var(--ink);
  --text-secondary: var(--muted);
  --focus-ring: var(--brand-primary);
  --action-primary: var(--brand-primary);
}
```

Use the existing light and dark themes, but verify that every action color has adequate contrast in both themes.

### Radius and elevation

Choose one product-wide rule and apply it consistently. Recommended:

- Cards: 0–4px radius
- Buttons and fields: 0–4px radius
- Pills: rounded only when they represent compact status
- Shadows: none or very subtle inset/elevation only
- No large neon glows

Remove or isolate legacy 16px/18px mobile rounding from the editorial surfaces.

### Theme behavior

The current dark theme uses gold as the main brand accent and the light theme uses deep red. Preserve the editorial intention only if contrast remains strong and the brand still feels consistent. If the white-label brand color is overridden, derive its hover, soft-background, focus, and on-color values rather than blindly applying one raw color to every context.

## Shared component work

Build or improve reusable primitives in `frontend/src/components/ui/`:

### `Surface` / `Card`

- Support `base`, `inset`, `interactive`, and `ruled` variants.
- Use semantic tokens only.
- Include consistent padding and heading spacing.
- Avoid mixing glass and flat treatments by default.

### `Button`

Variants:

- Primary: strong ink or brand background
- Secondary: transparent with border
- Ghost: text-only
- Danger: semantic red
- Success: semantic green, only where appropriate

Requirements:

- Minimum 44px touch target
- Visible `:focus-visible`
- Loading state
- Disabled state
- No transform-heavy hover animation

### `StatusBadge`

- Use semantic tone tokens.
- Include optional icon and text.
- Never depend on color alone.
- Keep pills compact and reserve them for status, not decoration.

### `StatusMeter`

Use for:

- Drawdown risk
- Profit target progress
- Password strength
- KYC status progression

It should accept `value`, `tone`, `label`, `description`, and `critical` props. The tone must remain visually distinct in light and dark modes.

### `EmptyState`, `LoadingState`, and `ErrorState`

Create consistent states with:

- Clear explanation
- Next action
- Optional supporting icon
- No vague “Nothing yet” unless there is genuinely no action required

## Phase 1: establish the visual foundation

### Files

- `frontend/src/styles/tokens.css`
- `frontend/src/App.css`
- `frontend/src/components/ui/ui.css`
- `frontend/src/styles/modes/public.css`
- `frontend/src/styles/modes/trader.css`
- `frontend/src/styles/modes/operator.css`
- `frontend/src/styles/responsive.css`

### Tasks

1. Normalize backgrounds, borders, text colors, radius, shadows, and focus states.
2. Replace hard-coded legacy colors with semantic tokens.
3. Remove gradient primary buttons from the editorial surfaces.
4. Reduce or remove backdrop blur from normal cards.
5. Keep subtle borders and double rules for hierarchy.
6. Add global `:focus-visible` treatment.
7. Add reduced-motion handling.
8. Ensure tables, inputs, selects, modals, drawers, and toasts work in both themes.
9. Remove conflicting duplicate component styles where possible.

### Acceptance criteria

- Public, trader, and operator surfaces look like the same brand.
- No random card radius or shadow style remains.
- Light and dark themes retain readable contrast.
- Buttons and fields have consistent height, padding, and focus states.

## Phase 2: improve the trader dashboard

### Files

- `frontend/src/pages/Dashboard.jsx`
- `frontend/src/components/Sidebar.jsx`
- `frontend/src/pages/DashboardHome.jsx`
- `frontend/src/components/CommandPalette.jsx`
- `frontend/src/components/ThemeToggle.jsx`

### Tasks

1. Make the active dashboard view URL-addressable while preserving the current component architecture. Query parameters are acceptable if nested route migration is too risky.
2. Make browser back, refresh, and deep links preserve the selected dashboard view.
3. Keep desktop navigation grouped, but reduce mobile bottom navigation to primary items plus a “More” menu.
4. Make active navigation states obvious through border, weight, and accent—not only background tint.
5. Add accessible labels to every icon-only control.
6. Make the account/profile area easier to discover on both desktop and mobile.
7. Keep notification badges meaningful and data-driven.
8. Improve loading, offline, and empty states so the user always knows what to do next.

### Recommended primary mobile navigation

- Home
- Trade
- Analytics
- Payouts
- More

Put Rules, History, KYC, Competitions, Support, Chat, Appeal, Affiliate, and Profile inside the More menu.

## Phase 3: redesign the trading terminal

### Files

- `frontend/src/components/TradingPanel.jsx`
- `frontend/src/components/OrderPanel.jsx`
- `frontend/src/components/RiskWarningBanner.jsx`
- `frontend/src/components/TradingViewWidget.jsx`
- `frontend/src/pages/ChallengeRules.jsx`
- `frontend/src/styles/trader.css`
- `frontend/src/App.css`

### Target structure

```text
Trading Terminal
├── Account + live feed status
├── Risk warning, if required
├── Account selector
├── Watchlist / instrument ticker
├── Main workspace
│   ├── Chart and account summary
│   ├── Risk and target meters
│   ├── Open positions and orders
│   └── Sticky order ticket
└── Terminal state / next action
```

### Tasks

1. Make account status and risk the first visual priority.
2. Reduce decorative glass panels and glow effects.
3. Keep the chart visually dominant.
4. Keep the order panel sticky on desktop and naturally stacked on mobile.
5. Use a consistent data-grid alignment for balance, equity, P&L, drawdown, and days remaining.
6. Standardize market status, account status, position status, and risk status.
7. Make low, medium, high, and critical drawdown states visibly distinct.
8. Add text labels and icons to critical risk states.
9. Ensure the order ticket clearly separates market and pending orders.
10. Make Buy and Sell actions visually strong but not decorative.
11. Add confirmation feedback after trade actions without disrupting the chart.
12. Ensure all tables scroll horizontally on small screens without breaking the page.

### Trading UX acceptance criteria

- A trader can identify selected account, live-feed health, current risk, and available action within five seconds.
- Buy/Sell, pending order, modify, partial close, and cancel actions remain unchanged functionally.
- Critical risk cannot be confused with medium risk.
- The chart and order ticket remain usable at 1440px, 1024px, 768px, and 390px widths.

## Phase 4: improve the landing page

### Files

- `frontend/src/pages/Landing.jsx`
- `frontend/src/pages/landing-sections/LandingHero.jsx`
- `frontend/src/pages/landing-sections/LandingFeatures.jsx`
- `frontend/src/pages/landing-sections/LandingCalculator.jsx`
- `frontend/src/pages/landing-sections/LandingComparison.jsx`
- `frontend/src/pages/landing-sections/LandingFAQ.jsx`
- `frontend/src/pages/landing-sections/LandingStyles.js`

### Tasks

1. Keep the editorial financial-print style, but reduce decorative background complexity.
2. Replace the hero placeholder “Plate I” visual with a real dashboard preview, real trader imagery, or a polished data illustration.
3. Use one clear primary CTA and one lower-emphasis secondary CTA.
4. Show account sizes and core challenge rules earlier.
5. Replace hard-coded metrics with verified data or explicit demo labels.
6. Keep section headings shorter and more confident.
7. Add visible proof near the first CTA: transparent rules, payout schedule, and trader support.
8. Reduce repeated content across features, comparison, scaling, and FAQ.
9. Keep mobile CTAs full width with comfortable touch targets.
10. Ensure reveal animations do not hide content when JavaScript or reduced motion is enabled.

### Recommended hero pattern

```text
Eyebrow: INSTITUTIONAL PROP TRADING
Headline: Trade with discipline. Scale with confidence.
Supporting text: Transparent rules, clear progression, and professional trading infrastructure.
Primary CTA: Choose an Account
Secondary CTA: See the Rules
Proof row: Transparent rules · Weekly payouts · Professional support
Visual: Product screenshot or premium trader/data image
```

## Phase 5: admin/operator experience

### Files

- `frontend/src/pages/admin/admin.css`
- `frontend/src/components/admin/AdminSidebar.jsx`
- `frontend/src/components/admin/AdminTopBar.jsx`
- `frontend/src/components/admin/AdminDataTable.jsx`
- `frontend/src/components/admin/AdminEntityDrawer.jsx`
- `frontend/src/components/admin/AdminStatCard.jsx`
- `frontend/src/components/admin/AdminFilterBar.jsx`

### Tasks

1. Keep admin denser than trader-facing screens, but retain the same brand tokens.
2. Make table hierarchy strong: column headers, row hover, selected state, and status state.
3. Standardize filters, saved views, export, density, and column-visibility controls.
4. Make drawers and modals feel like part of the same system.
5. Ensure the notification bell shows real alert data, useful empty state, and clear navigation behavior.
6. Add accessible names to hamburger, bell, close, profile, and overflow controls.
7. Distinguish destructive actions with confirmation and clear consequences.
8. Keep role and security indicators visible without overwhelming the top bar.

## Accessibility requirements

Audit the following:

- Keyboard navigation through sidebar, tabs, filters, tables, drawers, and modals
- Focus-visible styles
- Screen-reader names for icon-only buttons
- Correct heading order
- Form labels and error descriptions
- Color contrast in light and dark themes
- Reduced motion
- Touch targets of at least 44px
- Tables with horizontal scrolling on mobile
- Error, loading, success, and offline states

Use semantic HTML wherever possible. Do not solve accessibility only with ARIA when native elements are available.

## Performance requirements

The build currently succeeds, but chart and dashboard bundles are relatively large. After the UI work:

1. Preserve route-level lazy loading.
2. Avoid loading admin chart code for public or trader pages.
3. Lazy-load heavy chart components where practical.
4. Avoid importing duplicate icon or chart libraries into the same route unnecessarily.
5. Do not add large image assets without compression and responsive sizing.

## Validation commands

Run from `frontend/`:

```powershell
npm.cmd run build
npm.cmd test -- --run
```

Also validate at these viewport sizes:

- 1440 × 900
- 1280 × 800
- 1024 × 768
- 768 × 1024
- 390 × 844

Review at minimum:

- `/`
- `/login`
- `/checkout`
- `/dashboard`
- Dashboard Trade view
- Dashboard Analytics view
- Dashboard KYC view
- `/admin`
- `/admin/users`
- `/admin/payouts`
- `/admin/analytics`

Test both light and dark themes.

## Definition of done

- The interface consistently feels editorial, premium, and institutional.
- The landing page communicates trust and value quickly.
- The trader dashboard is easier to scan and navigate.
- The trading terminal prioritizes account state, chart, risk, and order entry.
- Mobile navigation is simplified and usable.
- No important status is communicated by color alone.
- No existing product functionality is lost.
- Light/dark theme contrast is acceptable.
- Build passes.
- Existing tests pass.
- Responsive QA passes at all required widths.

## Suggested implementation order

1. Inspect current git diff and establish a baseline.
2. Normalize tokens and shared primitives.
3. Migrate trading terminal surfaces and status meters.
4. Improve dashboard navigation and mobile layout.
5. Improve landing page conversion and visual assets.
6. Polish admin tables, drawers, and top bar.
7. Run tests, build, accessibility checks, and responsive QA.
8. Report changed files, known limitations, and any functionality that could not be safely migrated.

