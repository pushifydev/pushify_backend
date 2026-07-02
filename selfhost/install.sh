#!/usr/bin/env bash
# Pushify self-host installer.
#
#   curl -fsSL https://raw.githubusercontent.com/pushifydev/pushify_backend/main/selfhost/install.sh | bash
#
# Installs into ./pushify (override with PUSHIFY_DIR): clones the backend + dashboard, generates
# secrets, builds the Docker stack and starts it. Re-running is safe — it pulls the latest code
# and rebuilds; your .env and database volume are kept.
set -euo pipefail

REPO_ORG="${PUSHIFY_REPO_ORG:-pushifydev}"
INSTALL_DIR="${PUSHIFY_DIR:-$PWD/pushify}"
BACKEND_REPO="https://github.com/${REPO_ORG}/pushify_backend.git"
FRONTEND_REPO="https://github.com/${REPO_ORG}/pushify_frontend.git"

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

command -v git >/dev/null 2>&1 || fail "git is required"
command -v docker >/dev/null 2>&1 || fail "Docker is required — https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (docker compose ...)"
docker info >/dev/null 2>&1 || fail "Docker daemon is not running (or you need sudo/docker group)"

say "Installing Pushify into ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR"
cd "$INSTALL_DIR"

clone_or_pull() { # <repo-url> <dir>
  if [ -d "$2/.git" ]; then
    say "Updating $2"
    git -C "$2" pull --ff-only
  else
    say "Cloning $2"
    git clone --depth 1 "$1" "$2"
  fi
}
clone_or_pull "$BACKEND_REPO" pushify_backend
clone_or_pull "$FRONTEND_REPO" pushify_frontend

cp -f pushify_backend/selfhost/docker-compose.yml ./docker-compose.yml

if [ ! -f .env ]; then
  say "Generating .env (secrets + URLs)"
  # Best-effort public address for the dashboard/API URLs; localhost as a last resort.
  HOST_IP="$(curl -4fsS --max-time 5 https://ifconfig.me 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)"
  HOST_IP="${HOST_IP:-localhost}"
  cat > .env <<EOF
PUSHIFY_API_URL=http://${HOST_IP}:4000
PUSHIFY_FRONTEND_URL=http://${HOST_IP}:3000
PUSHIFY_API_PORT=4000
PUSHIFY_FRONTEND_PORT=3000
POSTGRES_PASSWORD=$(openssl rand -hex 16)
JWT_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)
TRUSTED_PROXY_HOPS=0
EOF
  say "Wrote ${INSTALL_DIR}/.env — optional integrations (email, GitHub OAuth, Hetzner, AI) are listed in pushify_backend/selfhost/.env.example"
else
  say "Keeping existing .env"
fi

say "Building and starting the stack (first build takes a few minutes)"
docker compose up -d --build

# shellcheck disable=SC1091
. ./.env
cat <<EOF

  Pushify is starting.

  Dashboard : ${PUSHIFY_FRONTEND_URL}
  API       : ${PUSHIFY_API_URL}/api/v1/health

  Next steps:
    1. Open the dashboard and create your account (first user).
    2. Add a deploy server: Servers → Add existing server. It can be THIS machine —
       deploys, nginx and SSL run on servers you attach over SSH, not inside these containers.
    3. Create a project from a Git repository and deploy.

  Manage:  cd ${INSTALL_DIR} && docker compose logs -f | ps | down
  Update:  re-run this installer, or: git -C pushify_backend pull && git -C pushify_frontend pull && docker compose up -d --build

EOF
