#!/bin/bash
# Restore PropFirm backups created by scripts/backup.sh
# Usage:
#   scripts/restore.sh /path/to/propfirm_YYYYMMDD_HHMMSS.sql.gz
# Optional environment variables:
#   REDIS_BACKUP_FILE=/path/to/redis_YYYYMMDD_HHMMSS.rdb.gz
#   UPLOADS_BACKUP_FILE=/path/to/uploads_YYYYMMDD_HHMMSS.tar.gz

set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /path/to/postgres_dump.sql.gz"
  exit 1
fi

POSTGRES_DUMP_FILE="$1"
REDIS_BACKUP_FILE="${REDIS_BACKUP_FILE:-}"
UPLOADS_BACKUP_FILE="${UPLOADS_BACKUP_FILE:-}"

if [[ ! -f "$POSTGRES_DUMP_FILE" ]]; then
  echo "Postgres dump file not found: $POSTGRES_DUMP_FILE"
  exit 1
fi

echo "[$(date -Iseconds)] Starting restore..."
echo "[$(date -Iseconds)] Restoring PostgreSQL from $POSTGRES_DUMP_FILE"

docker-compose exec -T postgres psql -U "${DB_USER:-propfirm}" -d "${DB_NAME:-propfirm}" -c "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;"
gunzip -c "$POSTGRES_DUMP_FILE" | docker-compose exec -T postgres psql -U "${DB_USER:-propfirm}" -d "${DB_NAME:-propfirm}"

echo "[$(date -Iseconds)] ✅ PostgreSQL restore complete"

if [[ -n "$UPLOADS_BACKUP_FILE" ]]; then
  if [[ ! -f "$UPLOADS_BACKUP_FILE" ]]; then
    echo "Uploads backup file not found: $UPLOADS_BACKUP_FILE"
    exit 1
  fi

  echo "[$(date -Iseconds)] Restoring uploads from $UPLOADS_BACKUP_FILE"
  docker-compose exec -T backend sh -lc "mkdir -p /app/uploads && find /app/uploads -mindepth 1 -maxdepth 1 -exec rm -rf {} +"
  gunzip -c "$UPLOADS_BACKUP_FILE" | docker-compose exec -T backend tar xf - -C /
  echo "[$(date -Iseconds)] ✅ Upload restore complete"
fi

if [[ -n "$REDIS_BACKUP_FILE" ]]; then
  if [[ ! -f "$REDIS_BACKUP_FILE" ]]; then
    echo "Redis backup file not found: $REDIS_BACKUP_FILE"
    exit 1
  fi

  echo "[$(date -Iseconds)] Restoring Redis snapshot from $REDIS_BACKUP_FILE"
  TMP_RDB="$(mktemp)"
  gunzip -c "$REDIS_BACKUP_FILE" > "$TMP_RDB"
  docker cp "$TMP_RDB" propfirm_redis:/data/dump.rdb
  rm -f "$TMP_RDB"
  docker-compose restart redis
  echo "[$(date -Iseconds)] ✅ Redis restore complete"
fi

echo "[$(date -Iseconds)] ✅ Restore complete"
