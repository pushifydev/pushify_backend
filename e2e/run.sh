#!/usr/bin/env bash
# npm run test:e2e — build the e2e box and run the deploy tests inside it (needs Docker).
# The checkout is mounted read-only and copied inside the box, so nothing the box does (npm
# rewriting yarn.lock for Linux, caches, node_modules) can touch your working tree. Linux
# node_modules and the box's Docker images live in named volumes and survive between runs.
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -q -t pushify-e2e e2e >/dev/null
exec docker run --rm --privileged \
  -e PUSHIFY_E2E_DB_ENGINES \
  -v "$PWD":/work:ro \
  -v pushify-e2e-node-modules:/app/node_modules \
  -v pushify-e2e-docker:/var/lib/docker \
  pushify-e2e "$@"
