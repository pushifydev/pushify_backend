#!/usr/bin/env bash
# Update a Pushify self-host install to the latest release (the only supported one — SECURITY.md).
#
#   cd pushify && ./pushify_backend/selfhost/update.sh --dry-run   # show what would change
#   cd pushify && ./pushify_backend/selfhost/update.sh             # update (asks first)
#
#   curl -fsSL https://raw.githubusercontent.com/pushifydev/pushify_backend/master/selfhost/update.sh \
#     | bash -s -- --dry-run
#
# Options:
#   --dry-run      fetch and print the plan; change no checkout, file or container
#   --yes          do not ask for confirmation (needed when there is no terminal, e.g. cron)
#   --allow-major  allow a MAJOR version jump (breaking changes — read CHANGELOG.md first)
#
# Install directory: PUSHIFY_DIR, else the current directory when it holds pushify_backend/,
# else ./pushify (the installer's default).
#
# What it does: fetches pushify_backend and pushify_frontend, prints the installed and the latest
# version from package.json and the CHANGELOG.md releases in between ([security] marks a release
# with a Security section), refuses a MAJOR bump without --allow-major, warns to take a backup,
# then fast-forwards both checkouts, refreshes docker-compose.yml and runs
# `docker compose up -d --build` (migrations run on start). The commits that were built are
# recorded in .pushify-deployed, so running it again when nothing changed does nothing, and a run
# whose build failed is built again next time. Your .env and data volumes are not touched.
set -euo pipefail

# Everything runs from main(): bash has the whole script in memory before the pull below replaces
# this file on disk.
main() {
  local DRY=0 YES=0 ALLOW_MAJOR=0 arg
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY=1 ;;
      --yes|-y) YES=1 ;;
      --allow-major) ALLOW_MAJOR=1 ;;
      -h|--help) sed -n '2,24p' "${BASH_SOURCE[0]:-$0}" 2>/dev/null || true; exit 0 ;;
      *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
  done

  local INSTALL_DIR
  if [ -n "${PUSHIFY_DIR:-}" ]; then INSTALL_DIR="$PUSHIFY_DIR"
  elif [ -d "$PWD/pushify_backend/.git" ]; then INSTALL_DIR="$PWD"
  else INSTALL_DIR="$PWD/pushify"
  fi

  command -v git >/dev/null 2>&1 || fail "git is required"
  command -v docker >/dev/null 2>&1 || fail "Docker is required — https://docs.docker.com/engine/install/"
  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (docker compose ...)"
  docker info >/dev/null 2>&1 || fail "Docker daemon is not running (or you need sudo/docker group)"

  [ -d "$INSTALL_DIR/pushify_backend/.git" ] && [ -d "$INSTALL_DIR/pushify_frontend/.git" ] \
    || fail "No Pushify install in ${INSTALL_DIR} (expected pushify_backend/ and pushify_frontend/ — set PUSHIFY_DIR)"
  cd "$INSTALL_DIR"

  local repo
  for repo in pushify_backend pushify_frontend; do
    git -C "$repo" diff --quiet HEAD -- || fail "$repo has local changes — commit or stash them first"
    say "Fetching $repo"
    git -C "$repo" fetch --quiet origin
    git -C "$repo" rev-parse --verify --quiet '@{upstream}' >/dev/null \
      || fail "$repo has no upstream branch (detached HEAD?) — check out master first"
    git -C "$repo" merge-base --is-ancestor HEAD '@{upstream}' \
      || fail "$repo cannot be fast-forwarded to $(git -C "$repo" rev-parse --abbrev-ref '@{upstream}') — it has commits of its own"
  done

  local be_head be_new fe_head fe_new current latest
  be_head="$(git -C pushify_backend rev-parse HEAD)"
  be_new="$(git -C pushify_backend rev-parse '@{upstream}')"
  fe_head="$(git -C pushify_frontend rev-parse HEAD)"
  fe_new="$(git -C pushify_frontend rev-parse '@{upstream}')"
  current="$(package_version < pushify_backend/package.json)"
  latest="$(git -C pushify_backend show '@{upstream}:package.json' | package_version)"
  [ -n "$current" ] && [ -n "$latest" ] || fail "Could not read the version from pushify_backend/package.json"

  local want deployed
  want="$(printf 'backend=%s\nfrontend=%s' "$be_new" "$fe_new")"
  deployed="$(cat .pushify-deployed 2>/dev/null || true)"
  if [ "$be_head" = "$be_new" ] && [ "$fe_head" = "$fe_new" ] && [ "$deployed" = "$want" ]; then
    say "Pushify ${current} is up to date — nothing to do"
    exit 0
  fi

  say "Backend:  ${current} (${be_head:0:7}) → ${latest} (${be_new:0:7})"
  say "Frontend: ${fe_head:0:7} → ${fe_new:0:7}"
  if [ "$be_head" = "$be_new" ] && [ "$fe_head" = "$fe_new" ]; then
    say "Code is current, but no successful update of these commits is recorded — the stack will be rebuilt"
  elif [ "$be_head" != "$be_new" ]; then
    say "Releases since ${current} (details in pushify_backend/CHANGELOG.md):"
    git -C pushify_backend show '@{upstream}:CHANGELOG.md' 2>/dev/null | releases_since "$current" || true
  fi

  if [ "${current%%.*}" != "${latest%%.*}" ] && [ "$ALLOW_MAJOR" -eq 0 ]; then
    fail "${current} → ${latest} is a MAJOR version change (breaking). Read CHANGELOG.md, then re-run with --allow-major"
  fi

  warn "Back up before updating: a new version can run database migrations that older code cannot undo."
  warn "  cd ${INSTALL_DIR} && docker compose exec -T postgres pg_dump -U pushify pushify | gzip > pushify-backup-\$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
  warn "  Keep .env as well: secrets in the database are encrypted with its ENCRYPTION_KEY."

  if [ "$DRY" -eq 1 ]; then
    say "Dry run — would fast-forward both checkouts, copy pushify_backend/selfhost/docker-compose.yml to ./docker-compose.yml and run: docker compose up -d --build"
    say "Nothing was changed."
    exit 0
  fi

  if [ "$YES" -eq 0 ]; then
    printf 'Backup done? Update now? [y/N] '
    local answer
    read -r answer 2>/dev/null </dev/tty || answer=""
    [[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted (no terminal? re-run with --yes)."; exit 1; }
  fi

  for repo in pushify_backend pushify_frontend; do
    say "Updating $repo"
    git -C "$repo" merge --ff-only --quiet '@{upstream}'
  done
  cp -f pushify_backend/selfhost/docker-compose.yml ./docker-compose.yml

  say "Building and restarting the stack"
  docker compose up -d --build
  printf '%s\n' "$want" > .pushify-deployed

  say "Pushify is now ${latest}. Check it: docker compose ps && docker compose logs --tail 50 api worker"
}

say()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m  %s\n' "$*"; }
fail() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# The top-level "version" of a package.json on stdin. No node needed: the host only has Docker.
package_version() {
  grep -m1 '"version"[[:space:]]*:' | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/'
}

# CHANGELOG.md on stdin: one line per release newer than $1 (Keep a Changelog headings,
# "## [X.Y.Z] - date"), with [security] when the release has a "### Security" section.
releases_since() {
  awk -v cur="$1" '
    function flush() { if (ver != "") { print "    " ver "  " date (sec ? "  [security]" : ""); n++ } ver = "" }
    /^## \[/ {
      flush()
      v = $2; sub(/^\[/, "", v); sub(/\].*$/, "", v)
      if (v == cur || n >= 25) { if (v != cur) print "    … older releases in CHANGELOG.md"; exit }
      if (v != "Unreleased") { ver = v; date = $4; sec = 0 }
      next
    }
    /^### Security/ { sec = 1 }
    END { flush() }
  '
}

main "$@"
