# Surface 01 — Public Landing Page

> Paste `00-PLATFORM-CONTEXT.md` and your theme before this file.

Route: `/`. Public, no auth. This is the page that has to convert a sceptical trader who has
already been burned by another prop firm. Its whole job is to make the rules feel knowable
before they pay.

**Ten blocks, in this exact order:** Nav · Hero · Live Stats · Features · Funding
(calculator) · How It Works · Testimonials · Refer & Earn · Comparison · FAQ · Footer.

Do not reorder them. The Features block sits **before** the pricing block on purpose — the
trader needs to know what they are buying before they see what it costs.

All copy quoted below is real product copy. Use it verbatim. Where a line is marked
*(live)*, the value comes from an API and must have loading and zero states.

---

## 0. Nav

Sticky. Starts transparent over the hero and becomes opaque on scroll.

- **Left:** logo + wordmark. Clicking it returns to top.
- **Centre:** in-page anchor links, in this order — `Funding` · `Features` · `How It Works` ·
  `Refer & Earn` · `FAQ`. Each smooth-scrolls to its section, offset so the sticky nav does
  not cover the section heading.
- **Centre, separate:** a `Transparency` link that navigates away to `/transparency` (a real
  page of audited platform statistics — it is the trust anchor of the whole site, so give it
  visual distinction from the anchor links rather than hiding it among them).
- **Right:** `Login` (secondary, → `/login`) and `Get Funded` (primary, → `/register`).
- **Mobile:** anchor links collapse into a burger menu containing the same links plus
  Transparency, Login, and Get Funded.

## 1. Hero

- **Eyebrow badge:** `live funding · 100% profit split · published rules`
- **Headline**, three lines, with "Your Own Capital." and "Ours." emphasised differently from
  the rest:

  > Stop Risking **Your Own Capital.**
  > Start Trading **Ours.**

- **Sub-paragraph:**

  > Pass one evaluation — 1, 2, or 3 steps, your choice — and trade up to $400,000 of our
  > capital, scaling to $30,000,000. Keep 100% of every payout — we make our money on the
  > entry fee, not your profits.

- **Primary CTA:** `Start From $4` — scrolls down to the Funding section (it does **not**
  navigate; the trader has not chosen a size yet).
- **Secondary CTA:** `View Account Sizes` — same destination.
- **Trust strip**, three items separated by dividers:
  - `3` `Challenge Models`
  - `{N}` `Funded Traders` *(live — animate the count up on reveal; show a dash, not a zero,
    while it is unknown)*
  - `Weekly` `Payout Cycles`
- **Visual:** a framed plate to the side of the copy holding a representation of the trading
  terminal. There is no product photography — draw or illustrate it. It should read as a real
  trading interface (price, chart, positions), not an abstract graphic.
- A scroll cue at the bottom of the viewport.

## 2. Live Stats

A full-width band directly under the hero. Data from `GET /api/public/landing-stats`,
re-polled every 60 seconds.

Four counters:

| Label | Value | Sub-detail |
|---|---|---|
| `Total paid out` | money, abbreviated (`$1.2M`, `$450K`) | `{N} completed payouts` |
| `Funded traders` | integer | `Across active funded accounts` |
| `Countries` | integer | `Trader footprint` |
| `Same-day payouts` | percentage | *(rate of payouts settled same day)* |

Below the counters: a horizontally scrolling ticker of **recent payouts** — amount and date
per entry, continuously marqueeing.

**States that matter more than the happy path here.** This is a new platform and these
numbers can genuinely be zero:

- *Loading* — skeleton the figures, do not show `0`.
- *Zero / early-stage* — the band must still look deliberate. If there are no payouts yet,
  the ticker is hidden entirely rather than showing an empty rail, and the counters read as
  honest starting values.
- *Fetch failed* — hide the band rather than render placeholder numbers. Never show an
  invented figure here; the entire point of the section is that these are real.

## 3. Features

- **Eyebrow:** `The Standard`
- **Heading:** `Institutional Grade. Challenge Ready.`
- **Lead:**

  > Run a transparent prop challenge with live quota controls, clear progression, and funded
  > scaling once you pass.

Six cards in an asymmetric grid — one full-width lead card, two half-width, three
third-width. Each card has an icon, a title, and a body. Verbatim:

1. **Live Challenge Access** *(full width)* — reuses the lead paragraph above as its body.
2. **Institutional Evaluation** *(half)* — "The same documented rules apply to every phase,
   whichever model you pick. Hit the profit target without breaching the drawdown limit. Pure
   skill-based selection — no surprise conditions revealed later."
3. **No Artificial Rush** *(half)* — "Each phase gives you 45 calendar days — enough room to
   trade your edge, not the clock. No minimum time to pass and no penalty for taking the full
   slippage."
4. **We Don't Take a Cut** *(third)* — "You keep 100% of what you make, and we refund your
   We execute where it matters, putting institutional weight behind your strategy."
5. **Unlimited Leverage** *(third)* — "No margin requirement and no cap on position size
   Commodities. Optimized for risk-adjusted returns and capital preservation."
6. **Curated Batch Releases** *(third)* — "Each account size has its own allocation
   to protect liquidity integrity. Once a tier fills, it reopens automatically the following
   month — check the live counter above before it does."

## 4. Funding — the pricing block

Anchor target for the nav's `Funding` link and both hero CTAs. **This is the most important
section on the page** and the one Lovable most often under-builds. It is not a slider
calculator; it is a two-stage picker.

- **Section lead:** "1 Step, 2 Step, or 3 Step. Every model trades under the exact same rules
  — no hidden catches either way."

### Stage 1 — choose a model

Three selectable cards, fetched live and sorted by phase count. The first (fastest) model is
pre-selected. Each carries a positioning badge:

| Model | Badge |
|---|---|
| 1-step | `FASTEST TO FUNDED` |
| 2-step | `MOST BALANCED` |
| 3-step | `LOWEST COST TO START` |

*If the model list comes back empty:* show `Challenge models are temporarily unavailable.
Please check back shortly.` and nothing else. Do not fall back to hardcoded models.

### Stage 2 — choose a size

Selecting a model re-renders a grid of **seven size cards** — $5K, $10K, $25K, $50K, $100K,
$200K, $400K — each showing that model's rules at that size. Card anatomy, top to bottom:

1. A `RECOMMENDED` flag overhanging the top edge, on the $25K card only.
2. A two-column header row: label `Account Size` on the left, `Price` on the right.
3. The two values beneath, on one baseline — size on the left, price on the right. These are
   the two largest figures on the card. Price is live; show a dash when unknown.
4. An **availability pill** plus the size's tier label:
   - `OPEN` — more than half the allocation remaining, or unlimited
   - `LOW` — half or less remaining
   - `FULL` — allocation exhausted
   - Tier label sits beside it: Advanced / Standard / Pro / Elite / Enterprise / Institutional
5. A full-width **`Buy Challenge`** button. When the size is full it reads `Full` and is
   disabled.
6. A hairline-separated **itemised rules list**, each row a label on the left and a figure on
   the right, and each label carrying a hoverable info tooltip:
   - `Profit Target` — one row **per phase**, formatted `Phase 1 · 10% in 45d`, `Phase 2 · 8%
     in 45d`. A 3-step model shows three rows here. This per-phase breakdown is the section's
     whole credibility argument — do not collapse it to a single number.
     Tooltip: "The percentage gain required to pass this phase."
   - `Max Loss` — tooltip: "Maximum drawdown allowed from your starting balance before the
     account is closed."
   - `Daily Loss` — tooltip: "Maximum drawdown allowed within a single day."
   - `Min Trading Days` — tooltip: "Minimum number of days you must trade before completing
     this phase."
   - `Split` — rendered as `100%`. Tooltip: "Your share of profits once funded, paid on
     this cadence."
7. A thin **allocation-remaining bar** at the foot of the card, filled proportionally to
   slots left, its treatment shifting across the same three thresholds as the pill.
8. When full, the bar is replaced by explanatory text — `All slots claimed — check back soon`,
   or `Not offered at this size` when that size has no price for this model.

Sold-out cards stay visible and legible at reduced prominence. Do not hide them: watching a
size be gone is the honest version of scarcity.

**Clicking `Buy Challenge`** stores the chosen size and model, then navigates to
`/checkout` — see `02-AUTH-AND-CHECKOUT.md`.

## 5. How It Works

- **Eyebrow:** `How It Works`
- **Heading:** `Here's Exactly What Happens After You Click Start` (emphasise "Start")
- **Lead:** "No surprise steps, no hidden fine print revealed after checkout. Choose your
  model, same rules at every phase, challenge access from $4."

A four-step vertical timeline. Each step has a two-digit numeral marker, a short stage tag, a
title, and a body:

1. `01` · tag `Sign Up` · **Choose Your Challenge** — "Pick a 1-step, 2-step, or 3-step model
   and your preferred account size, then complete checkout to activate — accounts are released
   as soon as payment clears."
2. `02` · tag `Evaluate` · **Phase 1 — Prove Your Skill** — "Hit the profit target within the
   phase time limit. Leverage is unlimited and there is no position-size cap. Stay within the
   drawdown limits — the same rules apply at every phase, no surprises."
3. `03` · tag `Verify` · **Verification Phases** — "Depending on your model, one or two more
   phases confirm you can reproduce your results under the same rules and drawdown limits.
   Pass them all and you are funded."
4. `04` · tag `Funded` · **Funded — Trade Real Capital** — "Your account is now backed by real
   capital in our broker. Your trades are executed on live markets. Earn your share of the
   profits from real trading results."

The last two steps are the payoff — let them carry more visual weight than the first two.

## 6. Testimonials

- **Eyebrow:** `Community`
- **Heading:** `What Traders Say About the Process`
- **Lead:** "Illustrative feedback reflecting how the program actually works — real trader
  stories coming soon."

**Read this before building the section.** There are no real testimonials yet. The quotes
below are illustrative and are attributed by **role and program only** — no names, no
handles, no avatars, no photos, no dollar figures, no dates. That is a deliberate compliance
decision, not an oversight to be helpfully filled in. Build the layout so that adding a real
name and photo later is easy, but ship it without them.

A masonry / staggered grid of eight cards. Each card shows a role, a program label, and the
quote:

| Role | Program | Quote |
|---|---|---|
| Funded Trader | 2-Step Program | "The rules were clear from day one — no surprises at payout time. That's rare in this industry." |
| Funded Trader | 3-Step Program | "Every phase plays by the same rulebook. Once I understood that, the whole evaluation felt a lot less intimidating." |
| Funded Trader | 1-Step Program | "Knowing my leverage and instruments upfront meant I could plan my risk before I ever placed a trade." |
| Evaluation Trader | Account Selection | "Account slots really do fill up — I watched a size go from open to full while I was deciding. Glad I didn't wait." |
| Funded Trader | 3-Step Program | "The entry cost felt low enough to just try it, instead of talking myself out of it for another month." |
| Funded Trader | 2-Step Program | "Knowing funded accounts trade on real liquidity, not a simulated bucket shop, made the decision easier." |
| Evaluation Trader | Dashboard | "My dashboard shows exactly where my drawdown and profit target stand, every single day. No guessing." |
| Funded Trader | 1-Step Program | "I started small to test the process, passed, and scaled up once I trusted how it worked." |

## 7. Refer & Earn

Anchor target for the nav's `Refer & Earn` link.

- **Eyebrow:** `Affiliate Program`
- **Heading:** `Refer a Trader, Earn For Life` (emphasise "Earn For Life")
- **Lead:** "Give friends a discount on their first challenge. Earn a recurring commission on
  every challenge they ever buy after that — no cap, no expiry."

Three-step timeline, same structural pattern as How It Works:

1. `01` · tag `Share` · **Get Your Link** — "Every trader gets a personal referral code and
   link the moment they sign up — find it on your Affiliate dashboard."
2. `02` · tag `Refer` · **They Save, You Earn** — "Anyone who signs up through your link gets
   {N}% off their first challenge. You start earning commission the moment they pay."
   *(The discount percentage is live from `GET /api/affiliates/settings-public`; default to
   10% if unavailable.)*
3. `03` · tag `Earn` · **Commission For Life** — "Every future challenge your referral ever
   buys — not just their first — pays you a commission, at a rate that climbs as you refer
   more traders."

Closing CTA, centred: `Create Your Account & Get Your Link` → `/register`.

## 8. Comparison

- **Eyebrow:** `Why us vs others`
- **Heading:** `Why Traders Leave Other Firms For Us`
- **Lead:** "You'll compare firms before you register — good. Here's the side-by-side, no
  marketing spin required."
- A `Start with {BrandName}` CTA in the section header → `/register`.

A three-column table: decision point, us, them. Header row reads `Decision point` /
`{BrandName}` / `Other firms`. Five rows, verbatim:

| Decision point | Us | Others |
|---|---|---|
| Account access | Monthly batch releases with transparent availability | Always-open sales funnels with vague capacity |
| Payout proof | Backend-synced paid-out tracker | Static screenshots or unverifiable claims |
| Evaluation model | Same disclosed rules at every phase, whichever model you pick | Hidden review rules revealed after traders pass |
| Risk controls | News, rollover, drawdown, and max-trade controls | Rule enforcement only after a dispute |
| Support workflow | KYC, disputes, tickets, and admin queues in one system | Manual inboxes and scattered evidence |

Name no competitor. The "others" column stays generic — that is a legal constraint.
On mobile, each row becomes its own stacked comparison block rather than a scrolling table.

## 9. FAQ

Anchor target for `FAQ`.

- **Eyebrow:** `FAQ`
- **Heading:** `Still On The Fence? Here's Every Answer.`
- **Lead:** "Every real objection, answered up front — not buried in a support queue."

**Three category filter pills** — `General` · `Rules` · `Funded` — with General active by
default. Selecting a category swaps the accordion contents and closes any open item. Single-
open accordion: opening one closes the other. Constrain the column width for readability;
this section is dense prose.

### General

- **How do I start a challenge?** — "Choose a 1-step, 2-step, or 3-step model, select an
  account size, complete checkout, and your challenge account is issued as soon as payment
  clears."
- **Why is there a challenge fee?** — "The fee covers the cost of backing your evaluation
  with real market data and, once you pass, real capital. We are selective about who we fund,
  which is why there is a multi-phase evaluation and limited spots each month."
- **How many accounts are available?** — "Accounts are released in limited monthly batches
  from a fixed pool. The exact number varies by account size. Once all spots
  for a given tier are claimed, you need to wait for the next monthly release."
- **Can I have more than one account?** — "No — you can have one active evaluation and one
  funded account at a time. If your evaluation fails, you may claim a new one when spots are
  available."
- **What account sizes are available?** — "Seven sizes, from $5,000 to $400,000, across every
  model — 1-Step, 2-Step, and 3-Step. The same rules apply at every size; only the price and
  the dollar value of the targets change."

### Rules

- **What are the evaluation rules?** — "Every phase of your chosen model has identical core
  rules: hit that phase's profit target within its time limit without breaching the maximum
  drawdown limit. Currently: 1-Step is a 16% target in 45 days; 2-Step is 10% then 8%, 45 days
  per phase; 3-Step is 8%, 6%, then 6%, 45 days per phase. The rules are exactly the same
  across every phase — no surprises."
- **What is the drawdown limit?** — "Currently 4% maximum trailing drawdown and 2% daily
  drawdown, on every model and every phase, evaluation and funded alike. The trailing floor
  only ever rises as you profit — it never resets against you. Exact dollar figures for your
  account are on your dashboard before you start."
- **What is the time limit?** — "Each phase has its own time limit, shown before you start —
  currently 45 days per phase on every model. If you do not reach the profit target in time,
  the evaluation is failed and you may start a new challenge when spots are available."
- **Is there a minimum number of trading days?** — "Yes — 5 qualifying trading days per
  evaluation phase, even if you hit the profit target sooner. A day only counts once you're up
  at least 0.75% of your starting balance on that day."
- **What is the consistency rule?** — "No single day's profit can make up more than 15% of
  your total profit when you hit the target. If it does, you're not failed — it's a soft hold.
  Keep trading to bring the ratio down and you'll pass automatically."
- **What leverage do you offer?** — "Leverage is unlimited and positions reserve no margin (Gold and
  Silver included). What governs your risk is the daily loss cap and the trailing drawdown
  management."
- **What instruments can I trade?** — a live-generated summary of tradable instruments
  (Forex majors and minors plus Gold and Silver). Do not hardcode a list.
- **Can I hold trades over the weekend?** — "Weekend holding is currently enabled for every
  account, evaluation and funded alike — it's a single platform-wide setting, not something
  that changes when you get funded. If that setting is ever disabled, positions are flattened
  automatically before the weekend close."
- **Do you allow automated trading bots?** — "Manual trading is the primary method supported
  on our platform. Automated strategies executed through our platform's tools may be reviewed
  on a case-by-case basis. Generic publicly sold bots, Grid bots, Martingale systems, and
  copy-trade services are not permitted."
- **Can I trade news events?** — "Yes, news trading is allowed. Opening or closing a position
  within 2 minutes before or after a red-folder news release is restricted — no actions are
  permitted during that window."

### Funded

- **What happens after I pass every phase?** — "You receive a funded account. You can request
  payouts based on your trading profits."
- **How do payouts work?** — "Payouts are on demand, not on a fixed cycle. You keep 100% of your
  profits, with a $50 minimum payout request. Before your first payout, you need at least 10
  qualifying trading days and 6% net profit on the account — after that, there's no further
  lock-up period."
- **Does my drawdown protection improve as I profit?** — "Yes. Once your funded account's
  equity reaches 2% above your starting balance, your drawdown floor locks in at that level
  for good — it won't drop back below it even if your equity pulls back later."
- **Is there a scaling plan?** — "Yes. Every time your funded account reaches a new 6%
  net-profit milestone, your risk-capacity multiplier doubles — compounding with every
  milestone you hit."
- **What trading platform do you use?** — "We use our own proprietary trading platform for all
  accounts — evaluation and funded. You trade directly in our platform from your browser. No
  downloads required. You will receive your login credentials after claiming your account."
- **What happens if I breach a rule on my funded account?** — "If you breach the drawdown
  limits on your funded account, the account will be closed. You may claim a new evaluation
  account when spots are available next month."

## 10. Footer

Three stacked parts.

**A. Closing CTA banner** — a bordered panel, centred:

- Heading: `The Capital Is Ready. Are You?`
- Sub: "Every account size updates in real time. Pick the model that fits your trading style
  before this month's batch fills."
- Button: `Get Started` → `/register`
- Fine print beneath: `Accounts released monthly · Limited availability`

**B. Link grid** — brand block spanning two columns plus three link columns.

- Brand block: wordmark, then "Prop trading challenges with transparent rules, per-size
  monthly quota enforcement, and funded progression once you pass." Then a row of four social
  icon tiles — Twitter/X, Discord, YouTube, Instagram.
- `PLATFORM` — Account Sizes (→ Funding section) · How It Works (→ that section) · Trading
  Rules (→ FAQ) · FAQ (→ FAQ)
- `SUPPORT` — Help Center · Discord Community · Contact Us · Submit Ticket *(all currently
  route to login/register, since support lives behind auth)*
- `LEGAL` — Terms of Service (`/terms`) · Privacy Policy (`/privacy`) · Refund Policy
  (`/refund-policy`) · Cookie Policy (`/cookie-policy`)

**C. Disclaimer bar** — mandatory, both paragraphs in full, with the lead-ins emphasised:

> **Risk Warning:** Trading Foreign Exchange (Forex) and Commodities carries a high level of
> risk and is not suitable for all investors. You may sustain a loss of some or all of your
> capital. Past performance is not indicative of future results.
>
> **Simulated Trading Disclaimer:** All accounts provided during the evaluation phases
> (1-step, 2-step, or 3-step, depending on the model chosen) are simulated demo accounts using
> live market quotes. Upon passing every phase, funded accounts are backed by the firm's real
> capital and trades may be executed on live markets. {BrandName} is not a broker, does not
> accept client deposits for trading, and does not provide financial advice. Challenge
> accounts are paid and limited in availability.

Then a bottom row: `© {year} {BrandName}. All rights reserved.` on the left, and four small
capability chips on the right — `WEB PLATFORM` · `FOREX` · `GOLD` · `SILVER`.

This disclaimer block is legally required. It may be visually quiet, but it must be legible —
do not reduce it below comfortable reading contrast or size.

---

## Workflow summary — where every control goes

| Control | Destination |
|---|---|
| Nav logo | top of page |
| Nav anchor links | in-page scroll, offset for the sticky nav |
| Nav `Transparency` | `/transparency` |
| Nav `Login` | `/login` |
| Nav `Get Funded` | `/register` |
| Hero `Start From $4` | scrolls to Funding section |
| Hero `View Account Sizes` | scrolls to Funding section |
| Model card | selects model, re-renders the seven size cards |
| Size card `Buy Challenge` | stores {size, model}, navigates to `/checkout` |
| Size card `Full` | disabled, no action |
| FAQ category pill | filters the accordion, collapses open item |
| Comparison CTA | `/register` |
| Affiliate CTA | `/register` |
| Footer `Get Started` | `/register` |
| Footer legal links | `/terms`, `/privacy`, `/refund-policy`, `/cookie-policy` |

**The purchase branch after `/checkout`:** a logged-out visitor is asked to register or log in
first; a logged-in trader proceeds straight to payment. Payment is always a hosted redirect
off-site. There is no card form on this page or any other.

## Performance and behaviour notes

- The hero renders immediately; every section below it is lazy-loaded with a placeholder that
  reserves its height, so the page must not shift as sections arrive.
- Sections reveal on scroll with a short stagger between children. Honour reduced-motion
  preferences — when set, content appears without transform or fade.
- Nav clicks, hero CTAs, calculator selections, and footer CTAs each fire an analytics event
  tagged with their placement. Keep the placements distinguishable in the markup.

## Do not, on this page

- Do not add a card-payment form, a pricing slider, or a currency selector.
- Do not add names, photos, or figures to the testimonials.
- Do not name a competitor in the comparison table.
- Do not add fabricated urgency (countdowns, viewer counts, "3 left!" when the API says
  otherwise). The slot allocation is the only scarcity, and it is real.
- Do not round or "improve" any rule figure.
- Do not drop the risk and simulated-trading disclaimers.
