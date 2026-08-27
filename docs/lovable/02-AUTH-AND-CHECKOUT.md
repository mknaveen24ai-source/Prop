# Surface 02 — Auth & Checkout

> Paste `00-PLATFORM-CONTEXT.md` and your theme before this file.

Four screens: `/login`, `/register`, `/checkout`, and the password-reset flow that lives
inside the login screen. These are the conversion bottleneck of the entire product — a trader
who has already decided to pay abandons here.

---

## 1. Login — `/login`

One route, three modes in the same screen. Do **not** split these into separate pages; the
transitions between them should feel like one continuous surface.

### Mode A — credentials (default)

- `Email`
- `Password`, with a show/hide toggle
- `Login` primary button, full width
- `Forgot password?` link → switches to Mode C
- `Don't have an account? Register` link → `/register`
- An error region above the form for wrong credentials, locked accounts, and rate limiting.
  Never say which of email or password was wrong.

### Mode B — two-factor (only if the account has it enabled)

Replaces the credential fields after a successful password step.

- Six separate single-character inputs for the TOTP code
- Focus auto-advances on entry, and backspace moves focus back
- Pasting a six-digit code fills all six boxes
- **Auto-submits the moment the sixth digit lands** — no button press needed, though a submit
  button remains for keyboard and assistive-tech users
- A `Back` affordance to return to the credential step
- Invalid code: clear all six boxes, return focus to the first, and say the code was invalid
  without revealing whether the password was right

### Mode C — forgot / reset password

Three steps, in place:

1. Email → sends a reset code
2. Reset code entry
3. New password + confirm, with a **live strength meter**

The strength meter has four distinct levels and must be distinguishable by more than colour —
a label and a fill length, not just a hue. (In the current build all four levels collapsed to
one indistinguishable treatment; that is the specific bug this rebuild is fixing.)

Then a confirmation state with a link back to Mode A.

## 2. Register — `/register`

**Two steps, not one page.** A step indicator at the top shows both, marking step 1 complete
once passed.

### Step 1 — the form

Heading `New Account`, sub-line "Create your {BrandName} account."

- `Full Name`
- `Email`
- `Password` with the same four-level live strength meter as reset
- `Country` — dropdown
- `Phone / WhatsApp` — **required**, because it receives the verification code. Make it
  obvious why it is required; this is the field people abandon on.
- `Referral Code` — optional. Validated live as the trader types, against a debounce. Three
  result states:
  - valid → show the discount it unlocks ("10% off your first challenge")
  - invalid → say so quietly, and do not block submission
  - checking → a subtle pending state
  Prefilled automatically from a `?ref=` query parameter, in which case it arrives already
  validated.
- Two checkboxes, both required: terms acceptance, and a residency-eligibility confirmation.
- Primary button advances to step 2 by sending the phone code.

Validate on submit, not on every keystroke, and show all errors at once rather than one at a
time.

### Step 2 — phone verification

Heading `Phone Verification`, sub-line "Verify your phone."

- Six boxed inputs, same behaviour as the login TOTP step: auto-advance, paste support,
  auto-submit on the sixth digit
- `Resend code` with a **60-second cooldown**, showing the remaining seconds
- A way back to step 1 to correct a mistyped number
- On successful verification the account is created and the trader lands in the dashboard —
  there is no separate "account created, now log in" step

## 3. Checkout — `/checkout`

Reached from the landing page's size cards, and from the dashboard's challenge wizard. It is a
**review-and-confirm** page, not a payment form.

### What it shows

A summary of the pending purchase, read from the selection made earlier:

- Model (1-step / 2-step / 3-step) and account size
- Price — and where a discount applies, the original price, the discount, and the final price
  as three distinct figures. Never show only the discounted number.
- Profit target per phase
- Maximum drawdown and daily drawdown
- Minimum trading days
- Time limit per phase
- Profit split and payout cadence

Same rule as the landing page: per-phase targets are itemised, not summed.

### Discount sources, applied in this order

1. **Referral discount** — automatically applied if the trader registered with a valid code.
   Show it as a named line item, not a mysterious price change.
2. **Prize voucher** — a collapsed link reading `Have a prize voucher code?` which expands to
   reveal: the explanation "Redeem a competition prize voucher for a free challenge account —
   no payment required.", a code input that upper-cases as you type, and a `Redeem` button
   (label becomes `Redeeming…` while in flight). A valid voucher **skips payment entirely**
   and issues the account. Invalid code: "Could not redeem this voucher. Please check the code
   and try again."

Edge case worth designing for: a referral discount can bring the price to zero on its own. In
that case the page must not send the trader to a payment step at all — it issues the account
directly, same as a voucher.

### The action

- Logged out → the primary action is `Register` / `Login`, and the selection is preserved
  through auth so the trader returns here rather than to the dashboard.
- Logged in → the primary action is `Proceed to Payment`, which **leaves the site** for a
  hosted payment page. Say so before they click. On return, the account is issued once payment
  clears — design a "waiting on payment confirmation" state, because that gap is real.

### States

- Price still loading — skeleton the figures, disable the action
- Size sold out between selection and checkout — block the purchase and send them back to
  choose again
- Trader already holds an active evaluation — blocked, with an explanation of the one-active-
  evaluation limit
- Payment failed or abandoned — recoverable, with the selection intact

## Workflow summary

| From | Control | To |
|---|---|---|
| Landing size card | `Buy Challenge` | `/checkout` with selection stored |
| `/checkout` (logged out) | `Register` | `/register`, then back to `/checkout` |
| `/checkout` (logged in) | `Proceed to Payment` | hosted payment, off-site |
| `/checkout` | `Redeem` (valid voucher) | account issued, → dashboard |
| `/login` | success | dashboard (or admin panel for admin credentials) |
| `/register` | OTP verified | dashboard, with the first-login onboarding overlay |

## Do not

- Do not build a card-number, expiry, or CVC field anywhere.
- Do not merge register into a single step — the phone code genuinely requires two.
- Do not use colour as the only signal in the password strength meter.
- Do not silently apply a discount without itemising it.
