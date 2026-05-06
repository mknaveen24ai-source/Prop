# Brevo SMTP Setup

This backend already supports real SMTP sending through [mailer.js](./mailer.js) and queued delivery through `npm run email:worker`.

## 1. Create Brevo account

- Sign up for the free Brevo plan.
- Free plan currently allows `300 emails/day`.

## 2. Authenticate your sender domain

Use a real domain you control. For best results, send from `support@yourdomain.com`.

In Brevo:

- Add and authenticate your sending domain
- Add the DNS records Brevo gives you
- Verify the sender mailbox if Brevo requests it

Recommended DNS outcomes:

- SPF includes Brevo
- DKIM is enabled
- DMARC exists for the domain

## 3. Set backend environment variables

Add this block to [`.env`](./.env):

```env
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=your-brevo-smtp-login
SMTP_PASS=your-brevo-smtp-key
SMTP_FROM=support@yourdomain.com
FIRM_NAME=Your Firm Name
FRONTEND_URL=https://yourdomain.com
```

Notes:

- Leave `SENDGRID_API_KEY` empty if you want the backend to stay on Brevo SMTP.
- `SMTP_FROM` is the address traders will see as the sender.

## 4. Verify the config

Run:

```powershell
cd E:\propfirm\backend
npm run email:verify
```

Expected result:

- provider shows `brevo`
- SMTP verification succeeds

If SMTP is missing, the script will tell you the app is still in local preview mode.

## 5. Start runtime services

Backend:

```powershell
cd E:\propfirm\backend
npm start
```

Email worker:

```powershell
cd E:\propfirm\backend
npm run email:worker
```

## 6. Smoke test

Recommended sequence:

1. Trigger `forgot password`
2. Confirm a job appears in `/admin/email-jobs`
3. Confirm the job reaches `sent`
4. Confirm the email arrives from `support@yourdomain.com`

Then test:

- new signup -> `welcome_onboarding`
- payout request -> `payout_requested`

## 7. Fallback behavior

If SMTP is removed later:

- the backend falls back to local preview transport
- preview messages are written to:
  - [`backend/logs/email-previews`](./logs/email-previews)

This is useful for local development, but it does not send real trader emails.
