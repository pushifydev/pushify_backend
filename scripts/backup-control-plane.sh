#!/usr/bin/env bash
# Nightly backup of Pushify's OWN database (the control plane) — projects, servers,
# domains, billing state. Customer databases have their own restore-tested backups;
# this is the one that would take the platform itself down if lost.
#
#   crontab -e  →  15 3 * * * /opt/pushify/pushify_backend/scripts/backup-control-plane.sh >> /var/log/pushify-backup.log 2>&1
#
# Reads DATABASE_URL from the backend .env. Keeps BACKUP_KEEP_DAYS locally and, when
# BACKUP_RCLONE_REMOTE is set (e.g. "offsite:" — ideally an rclone crypt remote over a
# Storage Box / B2 bucket, see docs/SELF_HOSTING.md), copies each dump off the machine and
# prunes copies there older than BACKUP_REMOTE_KEEP_DAYS — a backup on the same disk is not
# a backup. BACKUP_HEARTBEAT_URL (healthchecks.io, Uptime Kuma push, …) is pinged on success
# and at <url>/fail on failure, so a backup that silently stops running gets noticed.
#
# The dump holds secrets encrypted with the backend's ENCRYPTION_KEY: without that key a
# restore gets the platform back but not its secrets. Keep the .env somewhere safe as well.
set -euo pipefail

ENV_FILE="${ENV_FILE:-$(dirname "$0")/../.env}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/pushify}"
BACKUP_KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"
BACKUP_REMOTE_KEEP_DAYS="${BACKUP_REMOTE_KEEP_DAYS:-60}"
BACKUP_HEARTBEAT_URL="${BACKUP_HEARTBEAT_URL:-}"

STAMP="$(date -u +%Y-%m-%dT%H-%M-%SZ)"
log() { echo "[$STAMP] $*"; }

heartbeat() {
  [ -n "$BACKUP_HEARTBEAT_URL" ] || return 0
  curl -fsS -m 10 --retry 3 -o /dev/null "$BACKUP_HEARTBEAT_URL$1" || log "WARNING: heartbeat ping failed"
}
trap 'log "ERROR: backup failed (line $LINENO)"; heartbeat /fail' ERR

if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '"'"'"'')"
fi
: "${DATABASE_URL:?DATABASE_URL not found (set ENV_FILE or export DATABASE_URL)}"

# Check the upload path before spending the dump on it.
if [ -n "$BACKUP_RCLONE_REMOTE" ] && ! command -v rclone >/dev/null 2>&1; then
  log "ERROR: BACKUP_RCLONE_REMOTE is set but rclone is not installed" >&2
  false
fi

mkdir -p "$BACKUP_DIR"
OUT="$BACKUP_DIR/pushify-control-plane-$STAMP.sql.gz"

# Custom format would allow selective restore, but plain SQL + gzip restores anywhere with psql.
pg_dump "$DATABASE_URL" --no-owner --no-privileges | gzip -9 > "$OUT"
SIZE="$(du -h "$OUT" | cut -f1)"
log "dumped $OUT ($SIZE)"

# Sanity: a dump that is suspiciously small is a broken dump, not a small database — and a
# dump pg_dump didn't finish has no closing marker.
if [ "$(stat -c %s "$OUT")" -lt 10240 ]; then
  log "ERROR: dump is under 10 KB — refusing to trust it" >&2
  false
fi
gzip -t "$OUT"
if ! gzip -dc "$OUT" | tail -n 5 | grep -q 'PostgreSQL database dump complete'; then
  log "ERROR: dump has no completion marker — refusing to trust it" >&2
  false
fi

if [ -n "$BACKUP_RCLONE_REMOTE" ]; then
  REMOTE="${BACKUP_RCLONE_REMOTE%/}"
  case "$REMOTE" in *:) ;; *) REMOTE="$REMOTE/" ;; esac
  rclone copy "$OUT" "$REMOTE" --quiet
  # Listed back from the remote, not just "rclone exited 0"
  rclone lsf "$REMOTE" --include "$(basename "$OUT")" | grep -q . || { log "ERROR: upload not found on $REMOTE" >&2; false; }
  log "uploaded to $REMOTE"
  rclone delete "$REMOTE" --min-age "${BACKUP_REMOTE_KEEP_DAYS}d" --include 'pushify-control-plane-*.sql.gz' --quiet
fi

find "$BACKUP_DIR" -name 'pushify-control-plane-*.sql.gz' -mtime +"$BACKUP_KEEP_DAYS" -delete
log "done (keeping $BACKUP_KEEP_DAYS days locally${BACKUP_RCLONE_REMOTE:+, $BACKUP_REMOTE_KEEP_DAYS days on $BACKUP_RCLONE_REMOTE})"
heartbeat ""
