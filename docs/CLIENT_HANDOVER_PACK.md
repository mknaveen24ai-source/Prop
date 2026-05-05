# Client Handover Pack — PropFirm SaaS Platform

> This document is for **the client firm** receiving their platform. Keep it confidential.

---

## Your Platform Details

| Item | Value |
|---|---|
| Platform URL | *(filled by deployment engineer)* |
| Admin Panel | *(filled by deployment engineer)*/admin |
| Support Contact | *(your email)* |
| Deployment Date | *(date)* |

---

## What You've Received

✅ A fully functional prop trading simulation platform with:
- **Trader dashboard** — challenge account tracking, live prices, trading terminal
- **Challenge engine** — automatic pass/fail enforcement (drawdown, profit target, time limits)
- **Payout system** — trader payout requests with admin review workflow
- **KYC verification** — document upload and admin review
- **Email notifications** — automated emails for pass, fail, expire, payout events
- **Admin panel** — full control over all platform operations
- **2FA security** — both traders and admins can enable TOTP authenticator

---

## Your Platform Settings (Configured at Deployment)

| Setting | Value |
|---|---|
| Phase 1 Profit Target | _% |
| Phase 1 Max Drawdown | _% |
| Phase 1 Day Limit | _ days |
| Phase 2 Profit Target | _% |
| Phase 2 Max Drawdown | _% |
| Funded Max Drawdown | _% |
| Profit Share | _% |
| Minimum Payout | $_ |
| Max Accounts Per User | _ |

*These can be changed at any time in Admin > Settings. Changes only affect new accounts.*

---

## Your Credentials

> ⚠️ **These credentials were provided separately in your credentials file. Do not share them.**
>
> Admin password, database password, and all API keys were generated uniquely for your deployment.

**First login steps:**
1. Navigate to your Admin Panel URL
2. Log in with your admin credentials
3. **Immediately enable 2FA** — Admin > Settings > Security > Enable 2FA

---

## How Your Platform Works

### Challenge Flow

```
Trader registers
       │
       ▼
 Starts Phase 1
       │
  ┌────┤ Trading period (up to 30 days)
  │    │
  │    ├─ Hit profit target (10%) + no drawdown breach → PASS → Phase 2 Auto-created
  │    │
  │    └─ Exceed drawdown (10%) OR time limit → FAIL
       │
       ▼
 Starts Phase 2 (5% target, 5% drawdown, 30 days)
       │
       ├─ PASS → Funded Account Created ✅
       └─ FAIL → Account Closed
              │
              ▼
       Funded Trader
       │
       ├─ Request payout → Admin reviews → Pays out (80% of profit)
       └─ Exceed drawdown (5%) → Funded account closed
```

### Automatic Enforcement
The challenge engine runs every 30 seconds and automatically:
- Closes all open trades when drawdown is breached
- Fails the account and sends an email notification
- Passes the account when profit target is met
- Expires accounts that hit the day limit
- Sends drawdown warnings at 25%, 50%, 75%, 90% of limit

---

## Your Responsibilities (Ongoing Operations)

### Daily
- [ ] Check admin dashboard for flagged payouts
- [ ] Review new KYC submissions (Admin > KYC)
- [ ] Monitor live exposure table (aggregate open risk)

### Weekly
- [ ] Review new violations log for unusual patterns
- [ ] Process pending payout requests
- [ ] Check server backup completed (check backup log)

### Monthly
- [ ] Review platform analytics (accounts passed/failed/funded ratio)
- [ ] Renew SSL certificate if expiring within 30 days
- [ ] Update platform (pull latest from repo, rebuild Docker)

---

## Things That Require Your Attention

### A trader says they can't log in
→ Check Admin > Users. Search by email. The user may be banned, or KYC blocked.

### A trader says their trade was closed incorrectly
→ Admin > Accounts > [account] > View Trades. Check the `close_reason` field. Common values:
- `SL Hit` — stop loss triggered
- `TP Hit` — take profit triggered
- `Drawdown Limit Reached` — engine closed all trades
- `Auto Closed — Account Passed` — account passed the challenge

### A trader is requesting a payout
→ Admin > Payouts > Review. Verify KYC is approved. Verify the amount matches net profit. Approve once you've sent the payment.

### A trader says they didn't receive an email
→ Check your SMTP configuration. Test email from Admin > Settings > Email Test. Check SendGrid/SMTP logs.

### You want to change the challenge rules
→ Admin > Settings. Change the values. Click Save. Rules apply to all new accounts from that point.

### You want to add a new account size (e.g. $200k)
→ Admin > Settings > Account Sizes. Toggle the size on and set the price.

---

## What Is NOT Included

| Feature | Status |
|---|---|
| Real money trading / live MT5/MT4 connection | Not included in base platform (can be added) |
| Payment gateway integration (Stripe, Crypto) | Optional add-on — Stripe integration available |
| Leaderboard | Included (toggle in Admin > Settings) |
| Affiliate system | Included (affiliate codes generated per trader) |
| Mobile app | Not included |
| Multiple platform languages | Not included — English only |

---

## Technical Notes for Your Hosting Provider

- **Operating System:** Works on any Linux server running Docker (Ubuntu 22.04 LTS recommended)
- **Minimum specs:** 2 CPU cores, 4GB RAM, 40GB SSD
- **Recommended specs (production):** 4 CPU cores, 8GB RAM, 100GB SSD
- **Database:** PostgreSQL 16 (containerized)
- **Cache:** Redis 7 (containerized)
- **Ports needed open:** 80 (HTTP), 443 (HTTPS)
- **Backup:** Automatic daily backup to `/backups/` directory — includes Postgres, Redis, and uploaded files

---

## Emergency Contacts

| Issue | Who to contact |
|---|---|
| Server down / Docker issues | Your deployment engineer |
| Platform bugs / data issues | Your deployment engineer |
| Payment processing issues | Your payment provider |
| SSL certificate issues | Your hosting provider or Let's Encrypt |
| Email delivery issues | Your SMTP provider (SendGrid support) |

---

*This platform was built on the PropFirm SaaS stack. All custom configurations are specific to your deployment.*
