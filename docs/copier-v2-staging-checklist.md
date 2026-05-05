# Copier v2 Staging Checklist

## 1. Start the services
- Start the backend API.
- Start the copier worker.
- Start either:
  - the real MT5 bridge, or
  - the mock bridge with `npm run copier:mock-bridge`

## 2. Required environment values
- `DATABASE_URL`
- `MT5_BRIDGE_HOST`
- `MT5_BRIDGE_PORT`
- `COPIER_SMOKE_ADMIN_EMAIL`
- `COPIER_SMOKE_ADMIN_PASSWORD`
- `COPIER_SMOKE_TRADER_EMAIL`
- `COPIER_SMOKE_TRADER_PASSWORD`
- `COPIER_SMOKE_TRADE_ACCOUNT_ID`

Optional:
- `COPIER_SMOKE_TENANT_ID`
- `COPIER_SMOKE_TENANT_SLUG`
- `COPIER_SMOKE_MASTER_ACCOUNT_ID`
- `COPIER_SMOKE_FOLLOWER_KEY`
- `COPIER_SMOKE_FOLLOWER_NAME`
- `COPIER_SMOKE_INSTRUMENT`
- `COPIER_SMOKE_CLOSE_WAIT_SECONDS`

## 3. Worker health checks
- `GET /api/admin/copier/health` shows:
  - `runtime.running = true`
  - `runtime.socket_ready = true`
  - fresh `runtime.last_heartbeat_at`
  - low `runtime.queue_depth`

## 4. Copier topology checks
- Register the master account in `/api/admin/copier/masters`
- Register at least one follower in `/api/admin/copier/followers`
- Create at least one mapping in `/api/admin/copier/mappings`
- If the follower broker symbol differs, add `/api/admin/copier/symbol-mappings`

## 5. Smoke run
- Run `npm run copier:smoke`
- Confirm the script:
  - logs in admin and trader
  - ensures master/follower/mapping exist
  - opens a real trade
  - observes `OPEN_MARKET` job acknowledged
  - closes the trade
  - observes `CLOSE_POSITION` job acknowledged

## 6. Manual admin validation
- Open `/admin/copier`
- Check:
  - overview metrics are populated
  - follower snapshots have timestamps
  - queue tab shows acknowledged jobs
  - dead-letter tab is empty
  - reconciliation has zero unexpected diffs

## 7. Bridge compatibility modes
- Default: strict ACK mode
  - `COPIER_BRIDGE_COMPAT_MODE=strict_ack`
- Legacy bridge fallback:
  - `COPIER_BRIDGE_COMPAT_MODE=optimistic_ack`
  - use only while migrating older bridges that do not emit correlation ACKs yet

## 8. Promotion criteria before production
- open/close smoke passes at least 3 times in a row
- no unexpected dead letters
- no stuck `sent` jobs after ACK timeout window
- follower snapshots update repeatedly
- reconciliation stays clean for open, modify, and close flows
