# Client Setup Guide — PropFirm SaaS Platform

> **Audience:** System administrator deploying a new client instance.

---

## Prerequisites

| Requirement | Version |
|---|---|
| Docker | 24+ |
| Docker Compose | v2+ |
| A registered domain pointing to the server | — |
| SSL certificate (Let's Encrypt or paid) | — |
| PowerShell 7+ (Windows) or Bash (Linux/Mac) | — |

---

## Step 1 — Clone the Repository

```bash
git clone https://your-private-repo/propfirm.git
cd propfirm
```

---

## Step 2 — Generate Client Secrets

Run the setup script to auto-generate all cryptographic secrets:

```powershell
# Windows PowerShell
.\scripts\setup_new_client.ps1 -FirmName "Alpha Prop" -Domain "app.alphatrade.com" -SupportEmail "support@alphatrade.com"
```

This creates:
- `.env` — all environment variables with generated secrets
- `CLIENT_CREDENTIALS_ALPHA_PROP.txt` — save this securely (shown once)

> ⚠️ **Never commit `.env` or the credentials file to Git.**

---

## Step 3 — Configure Branding

Edit `client.config.json` (copy from template):

```bash
cp client.config.template.json client.config.json
```

Fill in the following:

```json
{
  "firm_name": "Alpha Prop",
  "firm_slug": "alphaprop",
  "domain": "app.alphatrade.com",
  "support_email": "support@alphatrade.com",
  "primary_color": "#0066ff",
  "secondary_color": "#001133",
  "accent_color": "#ffd700",
  "logo_filename": "logo.png",
  "favicon_filename": "favicon.ico"
}
```

Place the client's `logo.png` and `favicon.ico` in `frontend/public/`.

---

## Step 4 — Configure SSL Certificates

Place your SSL certificate files in `deploy/certs/`:

```
deploy/
  certs/
    fullchain.pem    ← your certificate chain
    privkey.pem      ← your private key
```

**Using Let's Encrypt (recommended):**

```bash
# Install certbot
sudo apt install certbot
sudo certbot certonly --standalone -d app.alphatrade.com

# Copy certificates
sudo cp /etc/letsencrypt/live/app.alphatrade.com/fullchain.pem deploy/certs/
sudo cp /etc/letsencrypt/live/app.alphatrade.com/privkey.pem deploy/certs/
sudo chmod 644 deploy/certs/*.pem
```

---

## Step 5 — Fill in API Keys

Edit `.env` and add the remaining keys:

```env
# Email delivery
SENDGRID_API_KEY=SG.xxxxxxxxxxxxxxxxxxxx

# Market data (https://twelvedata.com — free tier available)
TWELVEDATA_API_KEY=your_api_key_here
```

> **Note:** The platform uses Ethereal (test inbox) if no SMTP is configured — emails will NOT be sent to traders. Configure email before going live.

---

## Step 6 — Deploy

```bash
# Build and start all services
docker-compose up -d --build

# Watch startup logs
docker-compose logs -f backend
```

Expected startup output:
```
propfirm_backend  | ✓ Redis connected
propfirm_backend  | ✓ Database connected
propfirm_backend  | ✓ Migration: XXX_initial_schema.js applied
propfirm_backend  | Server listening on port 5000
```

---

## Step 7 — Initialize Platform Settings

On first deploy, seed the platform settings via the setup API:

```bash
curl -X POST https://app.alphatrade.com/api/setup/init \
  -H "Content-Type: application/json" \
  -d '{
    "platform_name": "Alpha Prop",
    "phase1_profit_target_pct": 10,
    "phase1_max_drawdown_pct": 10,
    "phase2_profit_target_pct": 5,
    "funded_max_drawdown_pct": 5,
    "profit_share_pct": 80,
    "min_payout_amount": 50
  }'
```

> **This endpoint permanently locks itself after the first successful call.** Subsequent calls return `409 Conflict`.

---

## Step 8 — Log In to Admin Panel

Navigate to `https://app.alphatrade.com/admin`

- **Username:** `admin` (or the email configured in admin route)
- **Password:** Found in `CLIENT_CREDENTIALS_*.txt` (the `Admin Password` field)

**Recommended first actions:**
1. Enable Admin 2FA: Admin > Settings > Security
2. Configure account size quotas: Admin > Settings > Account Sizes
3. Set payout methods and minimum: Admin > Settings > Payouts
4. Add a welcome announcement: Admin > Announcements

---

## Step 9 — Verify Onboarding Checklist

```bash
curl https://app.alphatrade.com/api/setup/checklist
```

Aim for `"ready_for_traders": true` (5+ of 8 items complete) before promoting the platform.

---

## Maintenance

### Automatic Daily Backup
```bash
# Add to crontab (Linux)
0 2 * * * /opt/propfirm/scripts/backup.sh >> /var/log/propfirm-backup.log 2>&1
```

### Renewing SSL certificates
```bash
sudo certbot renew --pre-hook "docker-compose stop nginx" --post-hook "docker-compose start nginx"
```

### Updating to a new version
```bash
git pull origin main
docker-compose up -d --build
```

### Restarting services
```bash
docker-compose restart backend     # restart just the API
docker-compose restart             # restart everything
docker-compose down && docker-compose up -d  # full cold restart
```

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| `Connection refused` on port 80/443 | nginx not running | `docker-compose logs nginx` |
| `Invalid admin password` | `.env` ADMIN_PASSWORD not set | Check `.env`, restart backend |
| Emails not sending | SMTP not configured | Add SMTP_HOST + SMTP_USER + SMTP_PASS to `.env` |
| Prices not updating | TWELVEDATA_API_KEY missing or invalid | Check `.env` and API quota |
| `JWT malformed` errors | JWT_SECRET changed | All users re-login; expected after secret rotation |
| DB migration errors | Schema already existed with differences | Check `docker-compose logs backend`, run migrations manually |

---

## Architecture Overview

```
Internet
   │
   ▼
[Nginx :443] ── HTTPS, TLS 1.3, rate-limiting
   │
   ├──/api/──► [Backend :5000] ─── Express + Socket.IO
   │                   │
   │            ┌──────┴──────┐
   │            ▼             ▼
   │       [PostgreSQL]    [Redis]
   │
   └──/──────► [Frontend :80] ── React SPA (branded build)
```

**Data persistence:** All data stored in Docker volumes (`pgdata`, `redisdata`, `uploads`). Volumes survive container restarts and `docker-compose down`.
