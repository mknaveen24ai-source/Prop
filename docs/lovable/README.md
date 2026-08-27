> **⚠ Copy in this pack must match the platform, not the other way round.**
>
> These files quote product copy verbatim so a designer or a UI tool can reproduce it. That
> makes them a way for retired claims to come back. This pack previously specified a 75%
> profit split, 1:30 leverage, "$400,000" of capital, "real liquidity bridges", "zero
> artificial slippage" and a monthly quota reset — every one of which the code contradicted.
>
> Before using any of it, re-check these against source:
>
> | Claim | Source of truth |
> |---|---|
> | Profit split | `platform_settings.profit_share_pct` (currently **100%**) |
> | Leverage / position caps | `services/tradeShared.js` (**unlimited**, no margin) |
> | Scaling ceiling | `utils/stepModels.js` `scaling_max_account_size` |
> | Execution behaviour | `docs/TRADING_RULES_DISCLOSURES.md` |
> | Any rule shown to a trader | `frontend/src/pages/ChallengeRules.jsx`, which renders live settings |

# Lovable Prompt Pack

Paste-ready prompts for rebuilding this platform's frontend in Lovable.

These files describe **content and workflow only** — what exists on each screen, where its
data comes from, what every control does, and what states it can be in. They deliberately
contain **no visual direction**: no colors, no type choices, no spacing, no corner or shadow
treatment, no aesthetic adjectives. You supply the theme.

## Files

| File | Surface |
|---|---|
| `00-PLATFORM-CONTEXT.md` | Shared preamble — the product, the lifecycle, the glossary, the hard numbers |
| `01-LANDING.md` | Public landing page (10 sections) |
| `02-AUTH-AND-CHECKOUT.md` | Login, TOTP, password reset, 2-step register, checkout, voucher redemption |
| `03-TRADER-DASHBOARD.md` | Trader shell + 13 tabs |
| `04-TRADING-TERMINAL.md` | The Trade tab in full |
| `05-PUBLIC-PAGES.md` | Leaderboard, Transparency, Competitions, Trader Profile, legal pages |
| `06-ADMIN.md` | Admin shell + 18 routes + Support & Appeals Center |

## How to use it

**1. One Lovable project per surface.** Do not try to build the landing page, the trader
dashboard, and the admin panel in a single project. They share a design language but almost
no components, and Lovable degrades badly past a certain project size. Recommended split:

- Project A — landing + public pages + auth (`01`, `05`, `02`)
- Project B — trader dashboard + trading terminal (`03`, `04`)
- Project C — admin (`06`)

**2. Every prompt is a three-part paste.** In this order, in one message:

```
[ 00-PLATFORM-CONTEXT.md          — full contents, unedited ]
[ your theme / design system      — replaces the <<< ... >>> block ]
[ the surface file, e.g. 01-LANDING.md ]
```

`00` is what stops Lovable inventing prop-firm mechanics that do not match this platform.
It is short on purpose so you can afford to re-paste it every time.

**3. Build section by section, not page by page.** For anything larger than the landing
page, send the surface file once as context, then ask for one section per turn ("now build
the Positions & Orders table from section 4"). Lovable produces markedly better output on a
narrow ask against wide context than on a wide ask.

**4. Re-paste on every correction.** When Lovable drifts, do not argue with it — re-paste
the relevant section verbatim and say "match this exactly, including the copy". The quoted
copy in these files is real product copy from the current build; it is not a suggestion.

**5. Treat the numbers as frozen.** Profit targets, drawdown limits, account sizes, profit
split, and payout thresholds are real platform mechanics. If Lovable substitutes rounder or
more marketable numbers, that is a bug — every one of them appears in the trader's signed
terms.

## Where these came from

Assembled from the current codebase, and consistent with the two internal handoff docs at
the repo root — `PLATFORM_OVERVIEW_FOR_DESIGN.md` (routes, nav systems, design system, dead
code) and `PLATFORM_SPEC_FOR_DESIGN.md` (verified page-by-page inventory). Those two are
written for engineers and include backend route tables and stack details that would derail a
Lovable build; this pack is the same verified material re-cut for a design tool.

When the two disagree, the code wins. Section order in `01-LANDING.md` follows
`frontend/src/pages/Landing.jsx`, not the older spec doc.
