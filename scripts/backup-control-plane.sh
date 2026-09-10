#!/usr/bin/env bash
# Nightly backup of Pushify's OWN database (the control plane) — projects, servers,
# domains, billing state. Customer databases have their own restore-tested backups;
# this is the one that would take the platform itself down if lost.
#
#   crontab -e  →  15 3 * * * /opt/pushify/pushify_backend/scripts/backup-control-plane.sh >> /var/log/pushify-backup.log 2>&1
#
# Reads DATABASE_URL from the backend .env. Keeps BACKUP_KEEP_DAYS locally and, when
# BACKUP_RCLONE_REMOTE is set (e.g. "b2:pushify-backups" or "storagebox:backups"),
# copies each dump off the machine — a backup on the same disk is not a backup.
set -euo pipefail

ENV_FILE="${ENV_FILE:-$(dirname "$0")/../.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/pushify}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi
: "${DATABASE_URL:?DATABASE_URL not found (set ENV_FILE or export DATABASE_URL)}"

mkdir -p "$BACKUP_DIR"
STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
OUT="$BACKUP_DIR/pushify-control-plane-$STAMP.sql.gz"

# Custom format would allow selective restore, but plain SQL + gzip restores anywhere with psql.
pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip -9 > "$OUT"
SIZE="$(du -h "$OUT" | cut -f1)"
echo "[$STAMP] dumped $OUT ($SIZE)"

# Sanity: a dump that is suspiciously small is a broken dump, not a small database.
if [ "$(stat -c %s "$OUT")" -lt 10240 ]; then
  echo "[$STAMP] ERROR: dump is under 10 KB — refusing to trust it" >&2
  exit 1
fi

if [ -n "$BACKUP_RCLONE_REMOTE" ]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "$OUT" "$BACKUP_RCLONE_REMOTE/" --quiet
    echo "[$STAMP] uploaded to $BACKUP_RCLONE_REMOTE"
  else
    echo "[$STAMP] WARNING: BACKUP_RCLONE_REMOTE set but rclone is not installed" >&2
  fi
fi

find "$BACKUP_DIR" -name 'pushify-control-plane-*.sql.gz' -mtime +"$BACKUP_KEEP_DAYS" -delete
echo "[$STAMP] done (keeping $BACKUP_KEEP_DAYS days locally)"
