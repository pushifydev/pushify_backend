#!/usr/bin/env bash
# Runs inside the e2e box: starts the server side (Docker, sshd, nginx, Pebble) and the control
# plane's Postgres, then runs the e2e tests against it. Arguments are passed to vitest.
set -euo pipefail
log() { echo "[e2e] $*"; }

# cgroup v2 inside a container: move our processes out of the root cgroup and delegate the
# controllers, or runc can't create containers ("cannot enter cgroupv2 ... threaded mode").
# Same dance as the official docker:dind entrypoint.
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  sed -e 's/ / +/g' -e 's/^/+/' < /sys/fs/cgroup/cgroup.controllers > /sys/fs/cgroup/cgroup.subtree_control
fi

log "starting dockerd"
dockerd >/var/log/dockerd.log 2>&1 &
for _ in $(seq 1 60); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null 2>&1 || { tail -40 /var/log/dockerd.log; exit 1; }
# /var/lib/docker is a volume: drop app containers a previous run left behind (they hold ports)
docker ps -aq --filter name=pushify- | xargs -r docker rm -f >/dev/null

log "starting postgres"
service postgresql start >/dev/null
su postgres -c "psql -qtc \"SELECT 1 FROM pg_roles WHERE rolname='pushify'\" | grep -q 1 || psql -qc \"CREATE USER pushify WITH SUPERUSER PASSWORD 'pushify'\""
su postgres -c "psql -qtc \"SELECT 1 FROM pg_database WHERE datname='pushify_e2e'\" | grep -q 1 || createdb -O pushify pushify_e2e"
export DATABASE_URL=postgresql://pushify:pushify@127.0.0.1:5432/pushify_e2e

log "starting sshd (root, key only — Pushify connects to root@<ip>:22)"
mkdir -p /root/.ssh /run/sshd && chmod 700 /root/.ssh
[ -f /root/e2e_key ] || ssh-keygen -q -t ed25519 -N '' -f /root/e2e_key
cp /root/e2e_key.pub /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys
ssh-keygen -A >/dev/null
/usr/sbin/sshd
export PUSHIFY_E2E_SSH_KEY=/root/e2e_key

log "starting nginx (no systemd here: Pushify falls back to nginx -s reload)"
nginx

log "starting pebble (ACME test CA; validation skipped — there is no public DNS in here)"
docker rm -f pebble pushify-e2e-pebble >/dev/null 2>&1 || true
# Not on Docker's default bridge (builds only, on a runner), and named like Pushify's own so the
# runner rules treat its network as ours (lib/runner-isolation.ts)
docker network create e2e-infra >/dev/null 2>&1 || true
docker run -d --name pushify-e2e-pebble --network e2e-infra -p 14000:14000 \
  -e PEBBLE_VA_ALWAYS_VALID=1 -e PEBBLE_VA_NOSLEEP=1 -e PEBBLE_WFE_NONCEREJECT=0 \
  ghcr.io/letsencrypt/pebble:latest >/dev/null
mkdir -p /etc/letsencrypt
printf 'server = https://127.0.0.1:14000/dir\nno-verify-ssl = true\n' > /etc/letsencrypt/cli.ini
for _ in $(seq 1 30); do curl -sk https://127.0.0.1:14000/dir >/dev/null && break; sleep 1; done

log "starting a private registry (htpasswd auth, for the private-registry test)"
# Best effort: if Docker Hub is having a bad day, that one test skips instead of failing the run
start_registry() {
  mkdir -p /opt/e2e-registry/auth
  docker run --rm --entrypoint htpasswd httpd:2 -Bbn e2euser e2epass > /opt/e2e-registry/auth/htpasswd
  docker run -d --name pushify-e2e-registry --network e2e-infra -p 127.0.0.1:5000:5000 \
    -v /opt/e2e-registry/auth:/auth \
    -e REGISTRY_AUTH=htpasswd -e REGISTRY_AUTH_HTPASSWD_REALM=pushify \
    -e REGISTRY_AUTH_HTPASSWD_PATH=/auth/htpasswd registry:2 >/dev/null
  # /v2/ answers 401 once htpasswd is in place — that is the registry being up, not an error
  for _ in $(seq 1 30); do
    case "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5000/v2/ || true)" in
      200|401) return 0 ;;
    esac
    sleep 1
  done
  return 1
}
if start_registry; then
  # Docker treats localhost registries as plain HTTP, so no certificate is needed in here
  export PUSHIFY_E2E_REGISTRY=localhost:5000
  export PUSHIFY_E2E_REGISTRY_USER=e2euser
  export PUSHIFY_E2E_REGISTRY_PASS=e2epass
else
  log "WARNING: no private registry — the private-registry test will be skipped"
fi

log "configuring an rclone remote for the off-site backup test"
# A plain local remote standing in for S3 / a Storage Box: the code only knows "an rclone remote",
# so a directory on disk exercises the same upload, download and prune paths without a network.
mkdir -p /opt/e2e-offsite /root/.config/rclone
printf '[e2eoffsite]\ntype = local\n' > /root/.config/rclone/rclone.conf
export DB_BACKUP_RCLONE_REMOTE=e2eoffsite:/opt/e2e-offsite
export RCLONE_BIN=/usr/bin/rclone

# Fixture repos are created by the test process; git refuses repos owned by "someone else"
git config --system --add safe.directory '*'
git config --system user.email e2e@pushify.test
git config --system user.name 'Pushify E2E'
git config --system init.defaultBranch main

log "copying the checkout (mounted read-only) to /app"
mkdir -p /app
find /app -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -C /work --exclude=./node_modules --exclude=./.git -cf - . | tar -C /app -xf -
cd /app
if [ ! -x node_modules/.bin/vitest ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  log "installing dependencies (Linux node_modules live in a volume)"
  npm ci --no-audit --no-fund --loglevel=error
fi

log "migrating"
npx tsx src/migrate.ts

log "running e2e tests"
# Fixture repos are local (file://), which production refuses (lib/repo-settings-validate.ts)
export PUSHIFY_ALLOW_LOCAL_REPOS=1
# No Redis in here: without this, a REDIS_URL copied in from the developer's .env would make
# BullMQ retry a connection that will never work.
unset REDIS_URL
# Apps here answer on 127.0.0.1 (nip.io): monitoring may call them, and their certificates come
# from Pebble, whose CA nothing here trusts.
export PUSHIFY_ALLOW_PRIVATE_APP_URLS=1
export NODE_TLS_REJECT_UNAUTHORIZED=0
PUSHIFY_E2E=1 npx vitest run --no-file-parallelism src/e2e "$@"
