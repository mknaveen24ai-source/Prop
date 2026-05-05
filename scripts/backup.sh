#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# PropFirm — Automated Daily Backup
# Cron: 0 2 * * * /opt/propfirm/scripts/backup.sh >> /var/log/propfirm-backup.log 2>&1
# ─────────────────────────────────────────────────────────────────────────────

set -euo pipefail

BACKUP_DIR="$(dirname "$0")/../backups"
DATE=$(date +%Y%m%d_%H%M%S)
KEEP_DAYS=30

mkdir -p "$BACKUP_DIR"

echo "[$(date -Iseconds)] Starting backup..."

# ── PostgreSQL dump ──────────────────────────────────────────────────────────
DUMP_FILE="$BACKUP_DIR/propfirm_${DATE}.sql.gz"

docker-compose exec -T postgres \
  pg_dump -U "${DB_USER:-propfirm}" "${DB_NAME:-propfirm}" \
  | gzip > "$DUMP_FILE"

DUMP_SIZE=$(du -sh "$DUMP_FILE" | cut -f1)
echo "[$(date -Iseconds)] ✅ PostgreSQL dump: $DUMP_FILE ($DUMP_SIZE)"

# ── Redis RDB snapshot ────────────────────────────────────────────────────────
REDIS_FILE="$BACKUP_DIR/redis_${DATE}.rdb.gz"

docker-compose exec -T redis \
  redis-cli -a "${REDIS_PASSWORD:-redispass}" BGSAVE > /dev/null 2>&1
sleep 2
docker-compose cp redis:/data/dump.rdb - | gzip > "$REDIS_FILE" 2>/dev/null || true
echo "[$(date -Iseconds)] ✅ Redis snapshot: $REDIS_FILE"

# ── Uploads directory ─────────────────────────────────────────────────────────
UPLOADS_FILE="$BACKUP_DIR/uploads_${DATE}.tar.gz"
docker-compose exec -T backend tar czf - /app/uploads > "$UPLOADS_FILE" 2>/dev/null || true
echo "[$(date -Iseconds)] ✅ Uploads: $UPLOADS_FILE"

# ── Cleanup old backups ───────────────────────────────────────────────────────
DELETED=$(find "$BACKUP_DIR" -name "*.gz" -mtime +"$KEEP_DAYS" -delete -print | wc -l)
echo "[$(date -Iseconds)] 🗑️  Deleted $DELETED backup(s) older than ${KEEP_DAYS} days"

echo "[$(date -Iseconds)] ✅ Backup complete"
