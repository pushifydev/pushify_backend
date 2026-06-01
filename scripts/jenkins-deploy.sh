#!/usr/bin/env bash
# Jenkins "Execute shell" for pushify_backend (Linux agent or SSH deploy host).
# Prerequisites: Node 20+, npm, pm2, PostgreSQL client, .env on server, ecosystem.config.cjs
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

# Clean install (keep package-lock.json for reproducible builds)
if [[ -f package-lock.json ]]; then
  npm ci
else
  echo "WARN: no package-lock.json — using npm install"
  npm install
fi

# tsup → rollup native optional dep (lockfile often built on macOS; npm ci on Linux skips it)
if [[ "$(uname -s)" == "Linux" ]] && [[ ! -d node_modules/@rollup/rollup-linux-x64-gnu ]]; then
  echo "==> Installing Rollup Linux native binary for tsup build"
  npm install @rollup/rollup-linux-x64-gnu@4.57.0 --no-save
fi

npm run build

# Database migrations (requires DATABASE_URL in .env)
if [[ -f .env ]] && grep -q '^DATABASE_URL=' .env; then
  npm run db:migrate
else
  echo "WARN: skip db:migrate — .env or DATABASE_URL missing"
fi

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

echo "==> Deploy finished"
pm2 status
