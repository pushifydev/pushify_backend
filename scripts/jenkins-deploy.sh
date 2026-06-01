#!/usr/bin/env bash
# Jenkins "Execute shell" for pushify_backend (Linux agent or SSH deploy host).
# Prerequisites: Node 20+, npm, pm2, PostgreSQL client, .env on server, ecosystem.config.cjs
set -euo pipefail

BACKEND_DIR="${BACKEND_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
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
