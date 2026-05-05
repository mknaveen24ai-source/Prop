# Setup script for new client deployment (Windows PowerShell)
# Usage: .\scripts\setup_new_client.ps1 -FirmName "Alpha Prop" -Domain "app.alphatrade.com" -SupportEmail "support@alphatrade.com"
#
# Requirements: openssl on PATH (ships with Git for Windows)

param(
    [Parameter(Mandatory=$true)]  [string] $FirmName,
    [Parameter(Mandatory=$true)]  [string] $Domain,
    [Parameter(Mandatory=$false)] [string] $SupportEmail = "support@$Domain",
    [Parameter(Mandatory=$false)] [string] $PrimaryColor = "#0066ff"
)

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  PropFirm Client Setup: $FirmName" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# ── Generate secrets ─────────────────────────────────────────────────────────
function New-Secret([int]$bytes = 32) {
    $random = New-Object byte[] $bytes
    [System.Security.Cryptography.RandomNumberGenerator]::Fill($random)
    return ($random | ForEach-Object { '{0:x2}' -f $_ }) -join ''
}

function New-Password([int]$length = 20) {
    $chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%'
    return -join ((1..$length) | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
}

Write-Host "Generating cryptographic secrets..." -ForegroundColor Yellow

$JWT_SECRET        = New-Secret 32
$ADMIN_JWT_SECRET  = New-Secret 32
$TOTP_KEY          = New-Secret 32
$DB_PASSWORD       = New-Password 24
$REDIS_PASSWORD    = New-Password 24
$ADMIN_PASSWORD    = New-Password 20

# ── Create .env ───────────────────────────────────────────────────────────────
$EnvContent = @"
PORT=5000
NODE_ENV=production
DB_NAME=propfirm
DB_USER=propfirm
DB_PASSWORD=$DB_PASSWORD
DATABASE_URL=postgresql://propfirm:$DB_PASSWORD@postgres:5432/propfirm
REDIS_PASSWORD=$REDIS_PASSWORD
REDIS_URL=redis://:$REDIS_PASSWORD@redis:6379
JWT_SECRET=$JWT_SECRET
JWT_EXPIRES_IN=24h
ADMIN_JWT_SECRET=$ADMIN_JWT_SECRET
TOTP_ENCRYPTION_KEY=$TOTP_KEY
ADMIN_PASSWORD=$ADMIN_PASSWORD
FRONTEND_URL=https://$Domain
PLATFORM_NAME=$FirmName
BRAND_PRIMARY_COLOR=$PrimaryColor
SUPPORT_EMAIL=$SupportEmail
SENDGRID_API_KEY=__FILL_IN__
TWELVEDATA_API_KEY=__FILL_IN__
"@

$EnvContent | Out-File -FilePath ".env" -Encoding utf8 -Force

# ── Save credentials to a secure file ────────────────────────────────────────
$CredContent = @"
============================================================
CLIENT CREDENTIALS — $FirmName
Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
KEEP THIS FILE SECURE — DO NOT COMMIT TO GIT
============================================================

Platform URL:    https://$Domain
Admin Panel URL: https://$Domain/admin

Admin Username:  admin
Admin Password:  $ADMIN_PASSWORD

Database:
  Host:          localhost (postgres container)
  Name:          propfirm
  User:          propfirm
  Password:      $DB_PASSWORD

Redis Password:  $REDIS_PASSWORD

JWT Secret:      $JWT_SECRET
Admin JWT:       $ADMIN_JWT_SECRET
TOTP Key:        $TOTP_KEY

============================================================
NEXT STEPS:
1. Fill in SENDGRID_API_KEY and TWELVEDATA_API_KEY in .env
2. Place SSL certs in deploy/certs/fullchain.pem + privkey.pem
3. Run: docker-compose up -d --build
4. Access admin at https://$Domain/admin
5. Configure platform settings in Admin > Settings
============================================================
"@

$CredFile = "CLIENT_CREDENTIALS_$(($FirmName -replace '[^a-zA-Z0-9]', '_').ToUpper()).txt"
$CredContent | Out-File -FilePath $CredFile -Encoding utf8 -Force

Write-Host ""
Write-Host "✅ .env created successfully" -ForegroundColor Green
Write-Host "✅ Credentials saved to: $CredFile" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Fill in SENDGRID_API_KEY and TWELVEDATA_API_KEY in .env"
Write-Host "  2. Place SSL certs in deploy/certs/"
Write-Host "  3. Run: docker-compose up -d --build"
Write-Host "  4. Admin panel: https://$Domain/admin"
Write-Host "  5. Admin password: $ADMIN_PASSWORD" -ForegroundColor Cyan
Write-Host ""
