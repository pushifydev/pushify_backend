#!/usr/bin/env bash
# Pre-migration database backup, called by scripts/jenkins-deploy.sh.
#
#   DATABASE_URL=... BACKUP_DIR=... KEEP=7 bash scripts/db-backup.sh
#
# Writes a compressed custom-format dump (restore with `pg_restore --clean --if-exists -d <url>
# <file>`) named <database>-<UTC timestamp>.dump into BACKUP_DIR (default
# ~/pushify-db-backups: outside the Jenkins workspace, so a workspace wipe keeps them), then keeps
# only the newest KEEP dumps of that database. Staging and production on one host keep separate
# sets because the file name starts with the database name. Any failure exits non-zero, which
# stops the deploy before migrations run.
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-$HOME/pushify-db-backups}"
KEEP="${KEEP:-7}"

command -v pg_dump >/dev/null || { echo "ERROR: pg_dump not found (install the PostgreSQL client)" >&2; exit 1; }
command -v node >/dev/null || { echo "ERROR: node not found" >&2; exit 1; }

# Database name from the URL (…/dbname?params), for the file name only.
db_name="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[^/]*//[^/]*/##; s#[?].*$##')"
[[ "$db_name" =~ ^[A-Za-z0-9_.-]+$ ]] || db_name="db"

umask 077
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/${db_name}-${stamp}.dump"
tmp="$file.partial"

# Keep the password out of the process list: pg_dump gets the URL without it and the password
# through PGPASSWORD.
url_no_pw="$(node -e 'const u = new URL(process.argv[1]); u.password = ""; process.stdout.write(u.toString())' "$DATABASE_URL")"
PGPASSWORD="$(node -e 'process.stdout.write(decodeURIComponent(new URL(process.argv[1]).password))' "$DATABASE_URL")"
export PGPASSWORD

echo "==> Backing up database '$db_name' to $file"
if ! pg_dump --format=custom --compress=6 --no-owner --dbname="$url_no_pw" --file="$tmp"; then
  rm -f "$tmp"
  echo "ERROR: pg_dump failed — not continuing" >&2
  exit 1
fi
# A dump that pg_restore cannot list is not a backup.
if ! pg_restore --list "$tmp" >/dev/null; then
  rm -f "$tmp"
  echo "ERROR: backup file is not readable by pg_restore — not continuing" >&2
  exit 1
fi
mv "$tmp" "$file"
echo "==> Backup done ($(du -h "$file" | cut -f1))"

# Retention: newest KEEP dumps of this database stay.
ls -1t "$BACKUP_DIR"/"${db_name}"-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while IFS= read -r f; do
  rm -f -- "$f"
  echo "    removed old backup $(basename "$f")"
done
