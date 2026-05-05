# Admin User Guide — PropFirm Platform

> **Audience:** The admin user for a deployed PropFirm instance.

---

## Accessing the Admin Panel

Navigate to `https://your-domain.com/admin` and log in with your admin credentials.

> **Tip:** Enable 2FA immediately after first login — Admin > Settings > Security > Enable 2FA.

---

## Dashboard Overview

The dashboard provides real-time metrics across four panels:

| Panel | What it shows |
|---|---|
| **Accounts** | Active Phase 1, Phase 2, Funded, Failed, Passed, Expired counts |
| **Users** | Total users, KYC pending/approved, banned |
| **Trades** | Open positions, total closed PnL |
| **Payouts** | Pending requests, total paid out, flagged count |

The **Live Exposure** table below shows open positions grouped by instrument — use this to monitor your B-book risk in real time.

---

## Platform Settings

**Location:** Admin > Settings

These are the core challenge rules that apply to all new accounts.

### Challenge Rules

| Setting | Description | Default |
|---|---|---|
| `phase1_profit_target_pct` | Phase 1 profit target (% of starting balance) | 10% |
| `phase1_max_drawdown_pct` | Phase 1 max drawdown allowed | 10% |
| `phase1_day_limit` | Maximum trading days for Phase 1 | 30 |
| `phase2_profit_target_pct` | Phase 2 profit target | 5% |
| `phase2_max_drawdown_pct` | Phase 2 max drawdown | 5% |
| `phase2_day_limit` | Maximum trading days for Phase 2 | 30 |
| `funded_max_drawdown_pct` | Funded account max drawdown | 5% |

> **Important:** Changing these settings only affects **new accounts created after the change**. Existing accounts keep the rules they were created with.

### Payout Rules

| Setting | Description | Default |
|---|---|---|
| `profit_share_pct` | Trader's share of profits on funded accounts | 80% |
| `min_payout_amount` | Minimum payout request amount (USD) | $50 |

### Account Restrictions

| Setting | Description | Default |
|---|---|---|
| `max_accounts_per_user` | Max active challenge accounts per trader | 5 |
| `weekend_holding_enabled` | Allow traders to hold trades over weekends | true |
| `inactivity_auto_fail_enabled` | Auto-fail accounts with no trades after N days | true |
| `inactivity_fail_days` | Days of inactivity before auto-fail | 30 |
| `drawdown_type` | `trailing` (from peak) or `fixed` (from start) | trailing |

### Trading Size Limits

| Setting | Description | Default |
|---|---|---|
| `forex_lots_per_1k` | Max lots per $1,000 account size (Forex) | 0.20 |
| `commodity_lots_per_1k` | Max lots per $1,000 (Commodities/Indices) | 0.02 |
| `min_lot_size` | Minimum lot size allowed | 0.01 |
| `min_hold_seconds` | Minimum trade hold time (seconds) | 60 |
| `max_trades_per_1k` | Max open trades per $1,000 | 5 |
| `max_daily_trades` | Max trades opened per day | 20 |

---

## Managing Users

**Location:** Admin > Users

### KYC Review
Traders must pass KYC before requesting payouts.

1. Click a user's name to open their profile
2. View their submitted documents
3. Click **Approve** or **Reject** (provide a reason on rejection)
4. Approved users receive an email notification automatically

### Banning a User
If a trader violates terms:
1. Open the user profile
2. Click **Ban User** → enter reason
3. Banned users cannot log in; all open trades are automatically closed

### Viewing Trader History
Each user profile shows:
- All challenge accounts (active, failed, passed)
- Complete trade history with PnL
- Login history (IP addresses, timestamps)
- Violation log (drawdown breaches, rule violations)

---

## Managing Accounts

**Location:** Admin > Accounts

You can view, filter, and action any challenge account:

| Action | What it does |
|---|---|
| **Force Fail** | Closes all trades at current prices, marks account failed |
| **Force Pass** | Passes the account to next phase (use sparingly — bypasses rules) |
| **Adjust Balance** | Manual credit/debit to account balance (logged in audit trail) |
| **View Trades** | See all trades for this account |
| **Add Note** | Attach internal notes visible only to admins |

---

## Processing Payouts

**Location:** Admin > Payouts

### Payout States
- `pending` — trader submitted request, awaiting review
- `approved` — admin approved; payment being processed
- `paid` — payment sent; trader notified
- `rejected` — request declined (reason required)
- `flagged` — system flagged for review (unusual amount, trade pattern, etc.)

### Review Process
1. Check the trader's KYC status (must be `approved`)
2. Verify the payout amount against the account's net profit
3. Confirm the payment method (USDT, bank transfer)
4. Click **Approve** → mark as **Paid** once sent

> **Never approve payouts for traders with `pending` KYC.**

---

## Violations Log

**Location:** Admin > Violations

The system automatically records every rule breach:

| Violation Type | Trigger |
|---|---|
| `drawdown_breach` | Account exceeded max drawdown |
| `lot_size_exceeded` | Trade opened above the lot size limit |
| `hold_time_violation` | Trade closed within the min hold time |
| `inactivity_fail` | Account failed due to 30+ days of no trading |
| `daily_trade_limit` | Trader exceeded max daily trades |

Use the **Severity** filter to prioritise `critical` violations.

---

## Announcements

**Location:** Admin > Announcements

Post platform-wide announcements visible to all traders on their dashboard.

- **Type:** `info`, `success`, `warning`, `error` (controls the banner color)
- **Enabled:** Toggle to show/hide without deleting the message

**Example use cases:**
- Maintenance notice: "We'll be performing maintenance on Saturday 2am–4am UTC."
- Market event: "Markets are closed for the holiday on Monday."
- Feature release: "New chart types are now available in the trading terminal."

---

## Tenant Management (Multi-Client)

**Location:** Admin > Tenants

If you are running multiple white-label brands on the same server, each brand is a "tenant."

Each tenant has:
- Its own domain (e.g. `app.brand1.com`, `app.brand2.com`)
- Its own traders and accounts
- Its own sub-admin user who manages only that brand's data

### Creating a New Tenant
1. Admin > Tenants > New Tenant
2. Enter: slug (URL-safe ID), name, primary domain
3. Create a Tenant Admin user (they only see their tenant's data)

---

## Security Best Practices

1. **Enable Admin 2FA** — Admin > Settings > Security. Without it, anyone who obtains the admin password has full access.
2. **Rotate the JWT secret** every 6 months. Do this in the `.env` file — all users will be logged out.
3. **Review the violations log weekly** for unusual patterns.
4. **Check the live exposure table daily** to monitor aggregate B-book risk.
5. **Never share admin credentials.** Create separate tenant admin accounts per brand.
6. **Audit trail** — every admin action is logged in Admin > Audit Log. This cannot be deleted.

---

## Onboarding Checklist

Check your deployment readiness at any time:

```bash
curl https://your-domain.com/api/setup/checklist
```

The response gives you a completion percentage and specific actions needed.

---

## Support

For platform issues: contact your deployment engineer with:
1. The exact error message (from the browser console or server logs)
2. The URL you were on when the error occurred
3. The approximate time (logs are timestamped in UTC)

**Server logs:**
```bash
docker-compose logs backend --tail=100
docker-compose logs nginx --tail=50
```
