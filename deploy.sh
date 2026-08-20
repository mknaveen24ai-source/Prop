#!/usr/bin/env bash
#
# ═════════════════════════════════════════════════════════════════════════════
# PropFirm — one-command deploy
#
#   ./deploy.sh --domain trade.example.com --email you@example.com
#   ./deploy.sh --self-signed --demo            # staging / evaluation
#
# Takes a fresh clone to a running, provisioned, health-checked stack.
#
# IDEMPOTENT. Every step is a no-op when already done, so re-running after a
# failure resumes rather than restarts. It never overwrites an existing .env and
# never replaces existing certificates — those are the two things you cannot get
# back, so they are only ever created, not modified.
# ═════════════════════════════════════════════════════════════════════════════

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$REPO_DIR"

ENV_FILE="$REPO_DIR/.env"
CERT_DIR="$REPO_DIR/deploy/certs"
BRIDGE_DIR="$REPO_DIR/deploy/mt5-bridge"

DOMAIN=""
ADMIN_EMAIL=""
SELF_SIGNED=0
WITH_DEMO=0
ASSUME_YES=0
SKIP_SMOKE=0

# The backend container runs as this uid (see backend/Dockerfile).
CONTAINER_UID=1001
CONTAINER_GID=1001

# ── Output ───────────────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
else
  BOLD=""; RED=""; GREEN=""; YELLOW=""; DIM=""; RESET=""
fi

step()  { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()    { printf '    %s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn()  { printf '    %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
info()  { printf '    %s%s%s\n' "$DIM" "$1" "$RESET"; }
die()   { printf '\n%serror:%s %s\n\n' "$RED" "$RESET" "$1" >&2; exit 1; }

usage() {
  cat <<'EOF'
PropFirm one-command deploy

Usage: ./deploy.sh [options]

TLS — pick one (nginx will not start without certificates):
  --domain <host>     Issue a Let's Encrypt certificate for <host> via certbot,
                      and set FRONTEND_URL/PUBLIC_API_URL to https://<host>.
                      Requires the host's DNS to already point here and port 80
                      to be free (certbot standalone claims it before nginx does).
  --self-signed       Generate a self-signed certificate instead. Browsers will
                      warn. For staging and evaluation only.

Options:
  --email <address>   Admin login address, and the certbot registration address.
  --demo              Also start the SYNTHETIC price feed, so the platform can be
                      exercised before a MetaTrader terminal is attached.
                      Not for production — see the warning it prints.
  --skip-smoke        Skip the post-deploy smoke test.
  -y, --yes           Never prompt. Requires --domain or --self-signed, and
                      --email unless a value already exists in .env.
  -h, --help          This message.

The price feed is FILE-BASED: a MetaTrader 5 terminal must run OUTSIDE these
containers and write DWX files into MT5_BRIDGE_PATH. Nothing here provides one.
See DEPLOYMENT_CHECKLIST.md section 8.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain)      DOMAIN="${2:-}"; shift 2 ;;
    --email)       ADMIN_EMAIL="${2:-}"; shift 2 ;;
    --self-signed) SELF_SIGNED=1; shift ;;
    --demo)        WITH_DEMO=1; shift ;;
    --skip-smoke)  SKIP_SMOKE=1; shift ;;
    -y|--yes)      ASSUME_YES=1; shift ;;
    -h|--help)     usage; exit 0 ;;
    *)             die "unknown option: $1 (try --help)" ;;
  esac
done

# ── Secret generation ────────────────────────────────────────────────────────
# backend/env.js rejects any secret under 32 chars or matching
# /your-|changeme|change-me|example|placeholder|password|default/i, so these
# must be genuinely random. 32 bytes of hex is 64 chars.
gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif [ -r /dev/urandom ]; then
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  else
    die "no openssl and no readable /dev/urandom — cannot generate secrets safely"
  fi
}

# Set KEY=VALUE in .env, replacing the WHOLE line.
#
# The template ships values with trailing comments (`DB_PASSWORD=  # REQUIRED`).
# Replacing only the value would leave the comment attached, and while both
# dotenv and compose strip trailing comments, a secret whose parsing depends on
# that is not a secret worth having.
set_env() {
  local key="$1" value="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # The value travels via the environment, not `awk -v`. `-v` processes
    # backslash escapes in the assignment, and it is not worth a class of
    # corrupted-secret bug to save one line. sed is avoided for the same reason:
    # a generated value containing / or & would corrupt the substitution.
    SET_ENV_VALUE="$value" awk -v k="$key" \
      'index($0, k "=") == 1 { print k "=" ENVIRON["SET_ENV_VALUE"]; next } { print }' \
      "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

get_env() {
  # Value only, trailing comment and whitespace removed.
  sed -nE "s/^$1=[[:space:]]*([^#]*).*/\1/p" "$ENV_FILE" 2>/dev/null | head -1 | sed -e 's/[[:space:]]*$//'
}

# Health of a compose service.
#
# Via `docker inspect` on the container id rather than `docker compose ps
# --format`, whose Go-template support varies across Compose v2 point releases —
# and a health probe that silently returns empty on some hosts would turn every
# wait loop below into a full-length timeout followed by a wrong diagnosis.
health_of() {
  local cid
  cid="$(docker compose ps -q "$1" 2>/dev/null | head -1)"
  [ -z "$cid" ] && { echo "missing"; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || echo "unknown"
}

wait_for_health() {
  local service="$1" attempts="$2" status=""
  for _ in $(seq 1 "$attempts"); do
    status="$(health_of "$service")"
    [ "$status" = "healthy" ] && return 0
    sleep 2
  done
  return 1
}

prompt() {
  local var="$1" question="$2" default="${3:-}"
  local answer=""
  if [ "$ASSUME_YES" = "1" ]; then
    printf -v "$var" '%s' "$default"
    return
  fi
  if [ -n "$default" ]; then
    read -r -p "    $question [$default]: " answer </dev/tty || true
    [ -z "$answer" ] && answer="$default"
  else
    read -r -p "    $question: " answer </dev/tty || true
  fi
  printf -v "$var" '%s' "$answer"
}

# ═════════════════════════════════════════════════════════════════════════════
# 1. Host preflight
# ═════════════════════════════════════════════════════════════════════════════
step "Checking the host"

command -v docker >/dev/null 2>&1 || die "docker is not installed. See https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || die "docker compose v2 is not available. The legacy 'docker-compose' binary will not work — this stack uses v2 syntax."
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon. Is it running, and is your user in the 'docker' group?"
ok "docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo 'ok'), compose v2"

if [ "$SELF_SIGNED" = "0" ] && [ -z "$DOMAIN" ] && [ ! -f "$CERT_DIR/fullchain.pem" ]; then
  if [ "$ASSUME_YES" = "1" ]; then
    die "no TLS option given. Pass --domain <host> or --self-signed."
  fi
  warn "No TLS option given, and deploy/certs/ is empty."
  info "nginx mounts fullchain.pem + privkey.pem and crash-loops without them."
  prompt DOMAIN "Domain to issue a Let's Encrypt certificate for (blank for self-signed)" ""
  [ -z "$DOMAIN" ] && SELF_SIGNED=1
fi

# ═════════════════════════════════════════════════════════════════════════════
# 2. .env
# ═════════════════════════════════════════════════════════════════════════════
step "Configuring .env"

if [ -f "$ENV_FILE" ]; then
  ok ".env already exists — left untouched"
  info "Delete it and re-run if you want a fresh one. Secrets in it are not regenerated."
else
  [ -f "$REPO_DIR/.env.template" ] || die ".env.template is missing — is this a complete clone?"
  cp "$REPO_DIR/.env.template" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ok "created from .env.template (mode 600)"

  for key in DB_PASSWORD REDIS_PASSWORD JWT_SECRET ADMIN_JWT_SECRET ADMIN_PASSWORD KYC_FILE_ENCRYPTION_KEY TOTP_ENCRYPTION_KEY CERTIFICATE_SIGNING_SECRET; do
    set_env "$key" "$(gen_secret)"
  done
  ok "generated 8 secrets (32 random bytes each)"

  if [ -z "$DOMAIN" ] && [ "$ASSUME_YES" = "0" ]; then
    prompt DOMAIN "Public domain (used for CORS and email links)" "localhost"
  fi
  PUBLIC_HOST="${DOMAIN:-localhost}"
  if [ "$PUBLIC_HOST" = "localhost" ]; then
    set_env FRONTEND_URL   "https://localhost"
    set_env PUBLIC_API_URL "https://localhost"
  else
    set_env FRONTEND_URL   "https://$PUBLIC_HOST"
    set_env PUBLIC_API_URL "https://$PUBLIC_HOST"
  fi
  ok "FRONTEND_URL=https://$PUBLIC_HOST  (this drives the CORS allowlist)"

  if [ -z "$ADMIN_EMAIL" ] && [ "$ASSUME_YES" = "0" ]; then
    prompt ADMIN_EMAIL "Admin login email" "admin@$PUBLIC_HOST"
  fi
  [ -z "$ADMIN_EMAIL" ] && ADMIN_EMAIL="admin@$PUBLIC_HOST"

  # MT5_BRIDGE_PATH must be absolute: compose resolves it relative to this file,
  # but the operator may later run compose from elsewhere.
  set_env MT5_BRIDGE_PATH "$BRIDGE_DIR"
  ok "MT5_BRIDGE_PATH=$BRIDGE_DIR"

  warn "SMTP is not configured. Password reset, KYC and payout emails will not send."
  info "Set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM in .env, then:"
  info "  docker compose up -d --force-recreate backend email-worker"
fi

[ -z "$ADMIN_EMAIL" ] && ADMIN_EMAIL="$(get_env SMTP_FROM)"
[ -z "$ADMIN_EMAIL" ] && ADMIN_EMAIL="admin@localhost"

# ═════════════════════════════════════════════════════════════════════════════
# 3. TLS certificates — before nginx, which claims port 80
# ═════════════════════════════════════════════════════════════════════════════
step "TLS certificates"

mkdir -p "$CERT_DIR"
if [ -f "$CERT_DIR/fullchain.pem" ] && [ -f "$CERT_DIR/privkey.pem" ]; then
  ok "certificates already present — left untouched"
elif [ -n "$DOMAIN" ] && [ "$SELF_SIGNED" = "0" ]; then
  info "Issuing a Let's Encrypt certificate for $DOMAIN (certbot standalone, needs port 80)..."
  docker run --rm -p 80:80 \
    -v "$CERT_DIR:/etc/letsencrypt/live/$DOMAIN" \
    certbot/certbot certonly --standalone -d "$DOMAIN" \
    --email "$ADMIN_EMAIL" --agree-tos --no-eff-email --non-interactive \
    || die "certbot failed. Check that $DOMAIN resolves here and port 80 is free."
  ok "certificate issued for $DOMAIN"
  info "Renewal is NOT automatic. Add to cron:"
  info "  0 3 * * * cd $REPO_DIR && docker run --rm -p 80:80 -v $CERT_DIR:/etc/letsencrypt/live/$DOMAIN certbot/certbot renew && docker compose restart nginx"
else
  openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
    -keyout "$CERT_DIR/privkey.pem" \
    -out "$CERT_DIR/fullchain.pem" \
    -subj "/CN=${DOMAIN:-localhost}" 2>/dev/null \
    || die "openssl failed to generate a self-signed certificate"
  ok "self-signed certificate generated for ${DOMAIN:-localhost}"
  warn "Browsers will show a security warning. Replace before taking real users."
fi
chmod 644 "$CERT_DIR/fullchain.pem" 2>/dev/null || true
chmod 600 "$CERT_DIR/privkey.pem"   2>/dev/null || true

# ═════════════════════════════════════════════════════════════════════════════
# 4. MT5 bridge directory
# ═════════════════════════════════════════════════════════════════════════════
step "MT5 bridge directory"

BRIDGE_PATH="$(get_env MT5_BRIDGE_PATH)"
[ -z "$BRIDGE_PATH" ] && BRIDGE_PATH="$BRIDGE_DIR"
mkdir -p "$BRIDGE_PATH"

# The backend runs as uid 1001 and WRITES here (DWX_Commands_0.txt, to subscribe
# to symbols). A root-owned bind mount mounts fine and then fails with EACCES on
# the first subscription, which surfaces as "no prices" rather than as a
# permission error.
if [ "$(id -u)" = "0" ]; then
  chown -R "$CONTAINER_UID:$CONTAINER_GID" "$BRIDGE_PATH"
  ok "$BRIDGE_PATH (owned by $CONTAINER_UID:$CONTAINER_GID)"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo chown -R "$CONTAINER_UID:$CONTAINER_GID" "$BRIDGE_PATH"
  ok "$BRIDGE_PATH (owned by $CONTAINER_UID:$CONTAINER_GID)"
else
  chmod 777 "$BRIDGE_PATH" 2>/dev/null || true
  warn "could not chown $BRIDGE_PATH to $CONTAINER_UID — fell back to mode 777"
  info "The backend must write DWX command files here. If symbol subscription fails, run:"
  info "  sudo chown -R $CONTAINER_UID:$CONTAINER_GID $BRIDGE_PATH"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 5. Build
# ═════════════════════════════════════════════════════════════════════════════
step "Building images"
docker compose build || die "image build failed"
ok "images built"

# ═════════════════════════════════════════════════════════════════════════════
# 6. Database
# ═════════════════════════════════════════════════════════════════════════════
step "Provisioning the database"

docker compose up -d postgres redis || die "could not start postgres/redis"
info "waiting for postgres to accept connections..."
wait_for_health postgres 60 || die "postgres did not become healthy. Check: docker compose logs postgres"
ok "postgres healthy"

# db:provision, NOT migrate. `knex migrate:latest` cannot provision a clean
# database and fails by design — see backend/scripts/provision-db.js.
docker compose run --rm migrate || die "database provisioning failed. Check: docker compose logs migrate"
ok "schema provisioned and verified"

# ═════════════════════════════════════════════════════════════════════════════
# 7. Start
# ═════════════════════════════════════════════════════════════════════════════
step "Starting the stack"

COMPOSE_PROFILES=""
[ "$WITH_DEMO" = "1" ] && COMPOSE_PROFILES="--profile demo"

# shellcheck disable=SC2086
docker compose $COMPOSE_PROFILES up -d || die "docker compose up failed"

info "waiting for the backend to report healthy..."
wait_for_health backend 90 || die "backend did not become healthy. Check: docker compose logs backend"
ok "backend healthy"

# ═════════════════════════════════════════════════════════════════════════════
# 8. Seed
# ═════════════════════════════════════════════════════════════════════════════
step "Seeding the platform"

# The schema dump is schema-only — a fresh database has 80 empty tables. This is
# the existing first-run endpoint (backend/routes/setup.js); it is idempotent and
# locks itself permanently once platform_settings has admin_token_version.
SETUP_OUT="$(docker compose exec -T backend wget -qO- \
  --header='Content-Type: application/json' \
  --post-data='{}' \
  http://localhost:5000/api/setup/init 2>/dev/null || true)"

if printf '%s' "$SETUP_OUT" | grep -q '"success"'; then
  ok "platform settings seeded"
elif docker compose exec -T backend wget -qO- http://localhost:5000/api/setup/status 2>/dev/null | grep -q '"initialized":true'; then
  ok "platform already initialized — skipped"
else
  warn "could not seed platform settings automatically"
  info "Run it yourself: curl -X POST https://$(get_env FRONTEND_URL | sed 's|https\?://||')/api/setup/init"
fi

ADMIN_OUT="$(docker compose exec -T backend npm run --silent admin:harden -- \
  --email "$ADMIN_EMAIL" --no-rotate-env 2>/dev/null || true)"
ADMIN_PASS="$(printf '%s' "$ADMIN_OUT" | sed -nE 's/.*"bootstrap_password": "([^"]*)".*/\1/p' | head -1)"

if [ -n "$ADMIN_PASS" ]; then
  ok "platform admin created: $ADMIN_EMAIL"
else
  ok "platform admin already exists — not modified"
fi

# ═════════════════════════════════════════════════════════════════════════════
# 9. Verify
# ═════════════════════════════════════════════════════════════════════════════
step "Verifying"

PREFLIGHT_OUT="$(docker compose exec -T backend npm run --silent deploy:preflight 2>&1 || true)"
printf '%s\n' "$PREFLIGHT_OUT" | sed 's/^/    /'
PREFLIGHT_OK=0
printf '%s' "$PREFLIGHT_OUT" | grep -q 'preflight passed' && PREFLIGHT_OK=1

# The permissive run above reports PASS on things that must NOT ship: zero admin
# 2FA coverage, and production env vars still holding development values. Those
# are only blockers under DEPLOY_CHECK_STRICT=1, and before this nothing anywhere
# set it -- not deploy.sh, not CI, not package.json. The strict gate existed and
# was never once invoked, so a real deployment finished on "Deployment preflight
# passed" with 0/N admins holding a second factor.
#
# Run strict too, and report what it finds. It cannot be the blocking check here:
# on a first install the admin was created minutes ago and cannot have enrolled
# 2FA yet, so failing the deploy on it would make the one-command deploy
# impossible to complete. Reporting it is the point -- the operator finishes
# knowing exactly what is left, rather than believing the platform is hardened.
HARDENING_OUT="$(docker compose exec -T -e DEPLOY_CHECK_STRICT=1 backend npm run --silent deploy:preflight 2>&1 || true)"
HARDENING_OK=0
printf '%s' "$HARDENING_OUT" | grep -q 'preflight passed' && HARDENING_OK=1
if [ "$HARDENING_OK" = "0" ]; then
  warn "production hardening is incomplete — the deploy is fine, this is what remains:"
  printf '%s\n' "$HARDENING_OUT" | grep '^FAIL' | sed 's/^/      /'
fi

if [ "$SKIP_SMOKE" = "0" ]; then
  step "Smoke test"
  info "registers a throwaway trader, issues it an account, opens and closes a trade"
  if [ -n "$ADMIN_PASS" ]; then
    # Without these the account-issue step skips and the trade path goes
    # unverified — which is the one thing this smoke test is for. They are only
    # available on the run that created the admin.
    info "(waits out the ${BOLD}min_hold_seconds${RESET}${DIM} rule — allow a couple of minutes)"
    docker compose exec -T \
      -e SMOKE_SUPER_ADMIN_EMAIL="$ADMIN_EMAIL" \
      -e SMOKE_SUPER_ADMIN_PASSWORD="$ADMIN_PASS" \
      backend npm run --silent launch:smoke -- --provision 2>&1 | sed 's/^/    /' || true
  else
    warn "admin password not available on this run (the admin already existed)"
    info "The trade steps will report SKIP. To verify the money path, re-run with:"
    info "  docker compose exec -e SMOKE_SUPER_ADMIN_EMAIL=$ADMIN_EMAIL -e SMOKE_SUPER_ADMIN_PASSWORD=... \\"
    info "    backend npm run launch:smoke -- --provision"
    docker compose exec -T backend npm run --silent launch:smoke -- --provision 2>&1 | sed 's/^/    /' || true
  fi
fi

# ═════════════════════════════════════════════════════════════════════════════
# 10. Report
# ═════════════════════════════════════════════════════════════════════════════
PUBLIC_URL="$(get_env FRONTEND_URL)"

printf '\n%s%s%s\n' "$BOLD" "════════════════════════════════════════════════════════════════" "$RESET"
if [ "$PREFLIGHT_OK" = "1" ] && [ "$HARDENING_OK" = "1" ]; then
  printf '%s  Stack is up and hardened.%s  %s\n' "$GREEN$BOLD" "$RESET" "$PUBLIC_URL"
elif [ "$PREFLIGHT_OK" = "1" ]; then
  # Deliberately distinct from a clean pass. "Stack is up" alone read as
  # production-ready while no admin held a second factor.
  printf '%s  Stack is up — hardening incomplete.%s  %s\n' "$YELLOW$BOLD" "$RESET" "$PUBLIC_URL"
else
  printf '%s  Stack is up, preflight is NOT green.%s  %s\n' "$YELLOW$BOLD" "$RESET" "$PUBLIC_URL"
fi
printf '%s%s%s\n\n' "$BOLD" "════════════════════════════════════════════════════════════════" "$RESET"

if [ -n "$ADMIN_PASS" ]; then
  printf '  %sAdmin login%s   %s\n' "$BOLD" "$RESET" "$PUBLIC_URL/admin/login"
  printf '  %sEmail%s         %s\n' "$BOLD" "$RESET" "$ADMIN_EMAIL"
  printf '  %sPassword%s      %s\n' "$BOLD" "$RESET" "$ADMIN_PASS"
  printf '                %sShown once. It is not stored anywhere you can read it back.%s\n\n' "$DIM" "$RESET"
fi

printf '  %sBefore real users:%s\n' "$BOLD" "$RESET"
printf '    1. Enrol TOTP 2FA for every platform admin. `deploy:preflight` FAILS\n'
printf '       until coverage is complete, and that is the intended gate — it is\n'
printf '       why the check above may be red on a first deploy.\n'
printf '    2. Attach MetaTrader 5 with the DWX expert advisor, writing into\n'
printf '       %s\n' "$BRIDGE_PATH"
printf '       There is no HTTP price source in this codebase; without a terminal\n'
printf '       there are no prices and nothing is tradeable.\n'
printf '    3. Configure SMTP if you have not — password reset silently no-ops.\n'
printf '    4. Test a database RESTORE, not just a backup (scripts/restore.sh).\n'
if [ "$WITH_DEMO" = "1" ]; then
  printf '\n  %sThe demo feed is running. Its prices are random walks, not market data.%s\n' "$YELLOW" "$RESET"
  printf '  Stop it before attaching a real terminal — both write the same file:\n'
  printf '    docker compose --profile demo stop dwx-demo\n'
fi
printf '\n  %sUseful:%s\n' "$BOLD" "$RESET"
printf '    docker compose ps                 service health\n'
printf '    docker compose logs -f backend    backend logs\n'
printf '    ./deploy.sh                       re-run safely (idempotent)\n\n'
