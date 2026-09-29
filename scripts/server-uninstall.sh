#!/usr/bin/env bash
# Remove what Pushify put on a server — one you connected (BYOS) or one Pushify created.
#
#   curl -fsSL https://raw.githubusercontent.com/pushifydev/pushify_backend/master/scripts/server-uninstall.sh \
#     | sudo bash -s -- --dry-run          # show what would be removed
#   ... | sudo bash -s -- --yes            # remove it
#
# Options:
#   --dry-run    print every step, change nothing
#   --yes        do not ask for confirmation
#   --keep-apps  leave Pushify's containers running (only remove access, nginx sites, firewall rules)
#   --keep-data  leave /opt/pushify in place
#   --close-web-ports  also remove the firewall rules that allow 80 and 443. Off by default: nginx
#                stays installed, so closing them would take down any site you still serve with it.
#                Port 22 is never touched.
#
# What it removes (everything named or marked by Pushify):
#   1. Pushify's SSH keys: authorized_keys lines whose comment starts with "pushify-"
#   2. Containers named pushify-* (apps, databases, previews, compose stacks) — unless --keep-apps
#   3. The pushify-apps Docker network and the runner isolation rules (iptables chains
#      PUSHIFY-FWD / PUSHIFY-IN, pushify-runner-isolation.service; only on Pushify's shared runners)
#   4. nginx: sites-available/enabled pushify-*, conf.d/pushify-*.conf and preview-*-pr-*.conf;
#      /etc/nginx/nginx.conf restored from nginx.conf.pushify-backup when Pushify replaced it
#   5. Firewall openings for apps without a domain: the ports in /opt/pushify/port-registry.json
#      that fall in Pushify's app range 3001-4000. 22, 80 and 443 stay open (see --close-web-ports).
#   6. /opt/pushify — unless --keep-data
#
# What it does NOT remove: Docker, nginx and certbot themselves, Let's Encrypt certificates,
# Docker volumes (database data lives there — listed at the end so you can delete them yourself).
set -euo pipefail

DRY=0 YES=0 KEEP_APPS=0 KEEP_DATA=0 CLOSE_WEB=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    --yes|-y) YES=1 ;;
    --keep-apps) KEEP_APPS=1 ;;
    --keep-data) KEEP_DATA=1 ;;
    --close-web-ports) CLOSE_WEB=1 ;;
    -h|--help) sed -n '2,31p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

[[ $DRY -eq 1 || $(id -u) -eq 0 ]] || { echo "Run as root (sudo), or with --dry-run." >&2; exit 1; }

say() { printf '==> %s\n' "$*"; }
run() {
  if [[ $DRY -eq 1 ]]; then printf '    + %s\n' "$*"; else bash -c "$*" || printf '    (step failed, continuing): %s\n' "$*" >&2; fi
}
have() { command -v "$1" >/dev/null 2>&1; }

# ── What is here ─────────────────────────────────────────────────────────────────────────────
key_files=()
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [[ -f "$f" ]] && grep -qE ' pushify-[^ ]*$' "$f" && key_files+=("$f")
done
containers=()
if have docker; then
  while IFS= read -r c; do [[ -n "$c" ]] && containers+=("$c"); done < <(docker ps -a --format '{{.Names}}' 2>/dev/null | grep -E '^pushify-' || true)
fi
nginx_files=()
for f in /etc/nginx/sites-enabled/pushify-* /etc/nginx/sites-available/pushify-* /etc/nginx/conf.d/pushify-*.conf /etc/nginx/conf.d/preview-*-pr-*.conf; do
  [[ -e "$f" || -L "$f" ]] && nginx_files+=("$f")
done
# Only Pushify's app range (port-manager.ts: 3001-4000); anything else in the file is ignored, so
# 22, 80 and 443 can never be closed by this step.
APP_PORT_MIN=3001 APP_PORT_MAX=4000
ports=()
if [[ -f /opt/pushify/port-registry.json ]]; then
  while IFS= read -r p; do
    [[ "$p" =~ ^[0-9]+$ ]] && (( p >= APP_PORT_MIN && p <= APP_PORT_MAX )) && ports+=("$p")
  done < <(grep -oE '"port" *: *[0-9]+' /opt/pushify/port-registry.json | grep -oE '[0-9]+$' | sort -un)
fi

say "Pushify uninstall plan$([[ $DRY -eq 1 ]] && echo ' (dry run)')"
echo "    SSH keys:        ${#key_files[@]} file(s) with a pushify-* key: ${key_files[*]:-none}"
if [[ $KEEP_APPS -eq 1 ]]; then echo "    containers:      kept (--keep-apps)"; else echo "    containers:      ${containers[*]:-none}"; fi
echo "    nginx files:     ${#nginx_files[@]}$([[ -f /etc/nginx/nginx.conf.pushify-backup ]] && echo ' + restore nginx.conf from backup')"
echo "    firewall ports:  ${ports[*]:-none} ($([[ $CLOSE_WEB -eq 1 ]] && echo '80 and 443 also closed; 22 kept' || echo '22, 80 and 443 kept'))"
echo "    /opt/pushify:    $([[ $KEEP_DATA -eq 1 ]] && echo kept || ([[ -d /opt/pushify ]] && echo remove || echo 'not present'))"

if [[ $DRY -eq 0 && $YES -eq 0 ]]; then
  printf 'Proceed? [y/N] '
  read -r answer </dev/tty || answer=""
  [[ "$answer" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 1; }
fi

# ── 1. Containers and network ───────────────────────────────────────────────────────────────
if [[ $KEEP_APPS -eq 0 && ${#containers[@]} -gt 0 ]]; then
  say "Removing ${#containers[@]} Pushify container(s)"
  run "docker rm -f ${containers[*]}"
fi
if [[ $KEEP_APPS -eq 0 ]] && have docker && docker network inspect pushify-apps >/dev/null 2>&1; then
  run "docker network rm pushify-apps"
fi

# ── 2. Runner isolation (shared runners only) ──────────────────────────────────────────────
if have iptables && iptables -S PUSHIFY-FWD >/dev/null 2>&1; then
  say "Removing runner isolation rules"
  run "while iptables -w -D DOCKER-USER -j PUSHIFY-FWD 2>/dev/null; do :; done"
  run "iptables -w -S INPUT | grep -- '-j PUSHIFY-IN' | sed 's/^-A /-D /' | while read -r r; do iptables -w \$r; done"
  run "iptables -w -F PUSHIFY-FWD; iptables -w -X PUSHIFY-FWD; iptables -w -F PUSHIFY-IN 2>/dev/null; iptables -w -X PUSHIFY-IN 2>/dev/null; true"
fi
if [[ -f /etc/systemd/system/pushify-runner-isolation.service ]]; then
  run "systemctl disable --now pushify-runner-isolation.service 2>/dev/null; rm -f /etc/systemd/system/pushify-runner-isolation.service; systemctl daemon-reload"
fi

# ── 3. nginx ────────────────────────────────────────────────────────────────────────────────
if [[ ${#nginx_files[@]} -gt 0 || -f /etc/nginx/nginx.conf.pushify-backup ]]; then
  say "Removing Pushify nginx sites"
  [[ ${#nginx_files[@]} -gt 0 ]] && run "rm -f ${nginx_files[*]}"
  if [[ -f /etc/nginx/nginx.conf.pushify-backup ]]; then
    run "cp -a /etc/nginx/nginx.conf.pushify-backup /etc/nginx/nginx.conf && rm -f /etc/nginx/nginx.conf.pushify-backup"
  fi
  run "nginx -t && (systemctl reload nginx 2>/dev/null || nginx -s reload)"
fi

# ── 4. Firewall openings ────────────────────────────────────────────────────────────────────
# Same order the deploy worker uses to open them: ufw, else firewalld, else iptables.
close_port() {
  local p="$1"
  if have ufw; then run "ufw delete allow ${p}/tcp >/dev/null"
  elif have firewall-cmd; then run "firewall-cmd --permanent --remove-port=${p}/tcp >/dev/null"
  elif have iptables; then run "while iptables -D INPUT -p tcp --dport ${p} -j ACCEPT 2>/dev/null; do :; done"
  fi
}
if [[ ${#ports[@]} -gt 0 ]]; then
  say "Closing Pushify app ports: ${ports[*]}"
  for p in "${ports[@]}"; do close_port "$p"; done
fi
if [[ $CLOSE_WEB -eq 1 ]]; then
  say "Closing ports 80 and 443 (--close-web-ports)"
  close_port 80
  close_port 443
  if ! have ufw && have firewall-cmd; then
    run "firewall-cmd --permanent --remove-service=http --remove-service=https >/dev/null 2>&1; true"
  fi
fi
if ! have ufw && have firewall-cmd && [[ ${#ports[@]} -gt 0 || $CLOSE_WEB -eq 1 ]]; then
  run "firewall-cmd --reload >/dev/null"
fi

# ── 5. Data directory ──────────────────────────────────────────────────────────────────────
if [[ $KEEP_DATA -eq 0 && -d /opt/pushify ]]; then
  say "Removing /opt/pushify"
  run "rm -rf /opt/pushify"
fi

# ── 6. Access — last, so an SSH session running this keeps working until the end ───────────
for f in ${key_files[@]+"${key_files[@]}"}; do
  say "Removing Pushify's SSH key from $f"
  run "grep -vE ' pushify-[^ ]*\$' '$f' > '$f.pushify-tmp' || true; cat '$f.pushify-tmp' > '$f'; rm -f '$f.pushify-tmp'"
done

say "Done$([[ $DRY -eq 1 ]] && echo ' (nothing was changed)')."
if have docker; then
  vols="$(docker volume ls --format '{{.Name}}' 2>/dev/null | grep -iE 'pushify' || true)"
  [[ -n "$vols" ]] && { echo "    Docker volumes kept (may hold database data):"; echo "$vols" | sed 's/^/      /'; echo "    Delete with: docker volume rm <name>"; }
fi
echo "    Docker, nginx, certbot and certificates were left installed."
