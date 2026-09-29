#!/usr/bin/env bash
# Jenkins "Execute shell" for pushify_backend (Linux agent or SSH deploy host).
# Prerequisites: Node 20+, npm, pm2, PostgreSQL client (pg_dump/pg_restore >= server version),
# .env on server, ecosystem.config.cjs
#
# Order: install → build into dist.new → backup (pg_dump) → migrate → swap dist → pm2 reload.
# A failed backup or migration stops the deploy with the running version untouched.
set -euo pipefail

resolve_backend_dir() {
  if [[ -n "${BACKEND_DIR:-}" ]] && [[ -f "${BACKEND_DIR}/package.json" ]]; then
    echo "$BACKEND_DIR"
    return
  fi

  # Monorepo: workspace is repo root, backend in subdirectory
  if [[ -n "${WORKSPACE:-}" ]] && [[ -f "${WORKSPACE}/pushify_backend/package.json" ]]; then
    echo "${WORKSPACE}/pushify_backend"
    return
  fi

  # Standalone pushify_backend repo (Jenkins job checks out backend only)
  if [[ -n "${WORKSPACE:-}" ]] && [[ -f "${WORKSPACE}/package.json" ]]; then
    echo "${WORKSPACE}"
    return
  fi

  # Invoked as bash scripts/jenkins-deploy.sh from repo root
  local script_root
  script_root="$(cd "$(dirname "$0")/.." && pwd)"
  if [[ -f "${script_root}/package.json" ]]; then
    echo "$script_root"
    return
  fi

  echo "ERROR: Could not find pushify_backend (package.json). Set BACKEND_DIR or run from repo root." >&2
  exit 1
}

BACKEND_DIR="$(resolve_backend_dir)"
cd "$BACKEND_DIR"

echo "==> Deploy pushify_backend in $(pwd)"

# Optional: run tests before build (uncomment in Jenkins)
# npm ci
# npm run typecheck
# npm run test -- --run

# Dependencies — but `npm ci` deletes node_modules, and the running API loads parts of it on
# demand, so it is only done when package-lock.json actually changed since the last deploy.
LOCK_STAMP="node_modules/.pushify-lock-sha"
if [[ -f package-lock.json ]]; then
  LOCK_SHA="$(sha256sum package-lock.json | cut -d' ' -f1)"
  if [[ -d node_modules ]] && [[ -f "$LOCK_STAMP" ]] && [[ "$(cat "$LOCK_STAMP")" == "$LOCK_SHA" ]]; then
    echo "==> Dependencies unchanged — skipping npm ci"
  else
    echo "==> package-lock.json changed — npm ci (the API may be short of a module for a moment)"
    npm ci
    echo "$LOCK_SHA" >"$LOCK_STAMP"
  fi
else
  echo "WARN: no package-lock.json — using npm install"
  npm install
fi

# tsup → rollup native optional dep (lockfile often built on macOS; npm ci on Linux skips it)
if [[ "$(uname -s)" == "Linux" ]] && [[ ! -d node_modules/@rollup/rollup-linux-x64-gnu ]]; then
  echo "==> Installing Rollup Linux native binary for tsup build"
  npm install @rollup/rollup-linux-x64-gnu@4.57.0 --no-save
fi

# Build beside the running one, then put it in place in a single move: overwriting dist/ under a
# live process can hand it a half-written file.
rm -rf dist.new dist.old
TSUP_OUT_DIR=dist.new npm run build
[[ -f dist.new/index.js ]] || { echo "ERROR: build produced no dist.new/index.js" >&2; exit 1; }

# Database: back up, then migrate — both BEFORE the new build is put in place. If either fails the
# script stops here (set -e) and the new build is thrown away, so the old code stays on disk as
# well as in memory: a later pm2 restart (crash, reboot) cannot start new code on an old schema.
trap 'rm -rf dist.new; echo "ERROR: deploy stopped before the new build went live; the running version is unchanged." >&2' ERR

DB_URL=""
if [[ -f .env ]]; then
  DB_URL="$(grep -m1 '^DATABASE_URL=' .env | cut -d= -f2- | sed -E "s/^[\"']//; s/[\"']$//")"
fi
if [[ -z "$DB_URL" ]]; then
  echo "ERROR: DATABASE_URL missing in .env — not deploying without migrations" >&2
  false
fi

# Timestamped pg_dump before every migration run; the newest 7 per database are kept
# (scripts/db-backup.sh, BACKUP_DIR defaults to ~/pushify-db-backups). SKIP_DB_BACKUP=1 is an
# emergency override only, e.g. when the host's pg_dump is older than the server.
if [[ "${SKIP_DB_BACKUP:-0}" == "1" ]]; then
  echo "WARN: SKIP_DB_BACKUP=1 — migrating WITHOUT a fresh backup"
else
  DATABASE_URL="$DB_URL" bash scripts/db-backup.sh
fi

echo "==> Running database migrations"
npm run db:migrate

trap - ERR
if [[ -d dist ]]; then mv dist dist.old; fi
mv dist.new dist
rm -rf dist.old

# PM2: reload if already managed, else first start
if [[ ! -f ecosystem.config.cjs ]]; then
  echo "ERROR: ecosystem.config.cjs missing. Copy ecosystem.config.example.cjs and configure .env"
  exit 1
fi

if pm2 describe pushify-api >/dev/null 2>&1 \
  || pm2 describe pushify-worker >/dev/null 2>&1 \
  || pm2 describe pushify-backend >/dev/null 2>&1; then
  pm2 delete pushify-backend 2>/dev/null || true
  pm2 reload ecosystem.config.cjs --update-env
else
  pm2 start ecosystem.config.cjs
fi

pm2 save

# Reloading a single fork-mode process is a stop and a start: the API is unreachable while it
# boots. Two cluster instances restart one after the other instead (ecosystem.config.example.cjs).
api_mode="$(pm2 jlist 2>/dev/null | node -e '
  let d = ""; process.stdin.on("data", (c) => (d += c)).on("end", () => {
    let list = [];
    try { list = JSON.parse(d.slice(d.indexOf("["))); } catch {}
    const api = list.filter((p) => p.name === "pushify-api");
    process.stdout.write(api.length ? `${api[0].pm2_env.exec_mode}:${api.length}` : "");
  });' || true)"
if [[ -n "$api_mode" ]] && [[ "$api_mode" != cluster_mode:* ]]; then
  echo "NOTE: pushify-api runs as a single fork process — deploys interrupt it for a few seconds."
  echo "      For rolling restarts set instances: 2 / exec_mode: 'cluster' in ecosystem.config.cjs,"
  echo "      then once: pm2 delete pushify-api && pm2 start ecosystem.config.cjs && pm2 save"
fi

echo "==> Deploy finished"
pm2 status
