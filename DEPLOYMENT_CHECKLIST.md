# Deployment Checklist

Use this checklist before promoting the platform to production or a live pilot.

## Required Environment

- `NODE_ENV=production`
- `DATABASE_URL`
- `JWT_SECRET`
- `ADMIN_JWT_SECRET`
- `FRONTEND_URL`
- `CORS_ORIGINS`
- `TRUST_PROXY=true` when behind a proxy/load balancer
- `REDIS_URL` when Redis-backed rate limits, queues, or cache are enabled
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `FIRM_NAME`
- `PRICE_HISTORY_RETAIN_DAYS`
- `PRICE_HISTORY_1H_RETAIN_DAYS`
- `KYC_FILE_ENCRYPTION_KEY`

## Admin Access

- Create at least one active DB-backed platform admin in `platform_admins`.
- Confirm production env fallback admin login is disabled.
- Rotate any old `ADMIN_PASSWORD`; it must not be used for production access.
- Enroll 2FA for every platform admin and tenant admin.
- Confirm `/api/admin/security/status` reports DB-backed admin migration complete and 2FA coverage complete.

## Database And Migrations

- Run pending migrations before starting production services.
- Confirm startup does not rely on heavy repeated `ALTER TABLE` work.
- Confirm indexes exist for price history, candles, account lists, KYC queues, payout queues, and email jobs.
- Verify backups and restore procedure before accepting real users.

## KYC Storage

- Set `KYC_FILE_ENCRYPTION_KEY`; new local KYC uploads are encrypted at rest.
- Keep KYC documents behind authenticated admin document endpoints only.
- Move encrypted local KYC files to private object storage before larger production scale.

## Email

- Use a verified sender domain through Brevo, Resend, or another SMTP provider.
- Send a smoke test for forgot password, KYC submitted, and payout notification.
- Run the email worker separately with `npm run email:worker`.
- Confirm the admin email-jobs page shows queued, sent, retry, failed, and dead states.

## Trading And Price Feed

- Confirm MT5/DWX feed is updating all enabled symbols.
- Confirm stale-feed alerts are visible to admins.
- Run manual smoke tests: market open, pending create, pending trigger, SL close, TP close, manual close, partial close, drawdown fail, profit pass, and news block.
- Keep close/reduce-risk actions allowed during news restrictions.

## Verification Commands

Run these before deployment:

```bash
cd backend
npm run check
npm test
npm audit --audit-level=moderate

cd ../frontend
npm run build
npm audit --audit-level=moderate
```

## Go / No-Go

- Do not go live if tests fail, audits have unresolved moderate+ production vulnerabilities, admin 2FA is incomplete, database recovery is unstable, or price feed is stale.
