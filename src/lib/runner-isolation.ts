/**
 * Network isolation for a shared runner — one Docker host, many customers.
 *
 * Without it, every app sat on the default bridge with inter-container traffic on: any app could
 * open connections to any other app's container, to services on the host through the bridge
 * gateway (sshd, anything bound to 0.0.0.0), to private networks the host is attached to and to
 * the cloud metadata address — and every app port was also published on the public interface.
 *
 * Apps on a runner run on a network of their own, `pushify-apps` (bridge `pushify-apps0`,
 * inter-container traffic off). The rules below match that bridge — and Docker's default bridge,
 * where builds run, as long as nothing but Pushify is attached to it — so nothing else on the
 * host is touched. They live in two chains of our own, rebuilt on every run:
 *  - PUSHIFY-FWD (jumped to from DOCKER-USER, i.e. forwarded traffic):
 *      replies to existing connections pass; app → app and app → private / link-local / CGNAT
 *      ranges (other Docker networks included) are dropped. Apps served under a domain are
 *      published on 127.0.0.1 (nginx is the only way in); apps without one keep their public
 *      <server-ip>:<port>, the only URL they have.
 *  - PUSHIFY-IN (jumped to from INPUT for traffic arriving from the apps' bridge):
 *      replies pass, new connections to the host's 80/443 pass (an app may call its own public
 *      URL), everything else to the host is dropped.
 * Internet egress is untouched. A systemd unit re-applies the rules at boot.
 */

export const RUNNER_ISOLATION_SCRIPT_PATH = '/opt/pushify/runner-isolation.sh';
/** The Docker network apps (and their workers) run on on a shared runner. */
export const RUNNER_APP_NETWORK = 'pushify-apps';
const RUNNER_APP_BRIDGE = 'pushify-apps0';
const UNIT_NAME = 'pushify-runner-isolation.service';

/** Private (other Docker networks included), link-local (cloud metadata) and CGNAT ranges. */
const BLOCKED_RANGES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10', '169.254.0.0/16'];

export function runnerIsolationScript(): string {
  const br = RUNNER_APP_BRIDGE;
  return `#!/bin/sh
# Pushify shared-runner network isolation — generated, rewritten on every deploy.
set -e
ipt() { iptables -w "$@"; }

docker network inspect ${RUNNER_APP_NETWORK} >/dev/null 2>&1 || docker network create --driver bridge \\
  -o com.docker.network.bridge.name=${br} \\
  -o com.docker.network.bridge.enable_icc=false \\
  ${RUNNER_APP_NETWORK} >/dev/null

# Traffic between containers on one bridge only reaches iptables through br_netfilter, which
# recent Docker versions no longer load on their own.
modprobe br_netfilter 2>/dev/null || true
sysctl -qw net.bridge.bridge-nf-call-iptables=1 2>/dev/null || true

# Builds (RUN steps of docker build) run on Docker's default bridge. On a runner nothing else
# belongs there, so it gets the same rules — unless a container that isn't Pushify's is attached
# to it: then that bridge is left alone and the deploy log says why.
BRIDGES="${br}"
DEFAULT_BRIDGE=$(docker network inspect bridge -f '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null || true)
[ -n "$DEFAULT_BRIDGE" ] || DEFAULT_BRIDGE=docker0
FOREIGN=$(docker ps --filter network=bridge --format '{{.Names}}' 2>/dev/null | grep -v '^pushify-' || true)
if [ -z "$FOREIGN" ]; then
  BRIDGES="$BRIDGES $DEFAULT_BRIDGE"
else
  ipt -D INPUT -i "$DEFAULT_BRIDGE" -j PUSHIFY-IN 2>/dev/null || true
  echo "PUSHIFY_ISOLATION_BUILDS_SKIPPED: $(echo $FOREIGN)"
fi

# Name lookups go to the host's resolvers, which may sit in a private range.
NAMESERVERS=$(awk '/^nameserver/ {print $2}' /etc/resolv.conf /run/systemd/resolve/resolv.conf 2>/dev/null | grep -v ':' | grep -v '^127\.' | sort -u)

ipt -N DOCKER-USER 2>/dev/null || true
ipt -N PUSHIFY-FWD 2>/dev/null || true
ipt -F PUSHIFY-FWD
ipt -A PUSHIFY-FWD -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
for b in $BRIDGES; do
  ipt -A PUSHIFY-FWD -i "$b" -o "$b" -j DROP
  for ns in $NAMESERVERS; do
    ipt -A PUSHIFY-FWD -i "$b" -d "$ns" -p udp --dport 53 -j RETURN
    ipt -A PUSHIFY-FWD -i "$b" -d "$ns" -p tcp --dport 53 -j RETURN
  done
  for range in ${BLOCKED_RANGES.join(' ')}; do
    ipt -A PUSHIFY-FWD -i "$b" -d "$range" -j DROP
  done
done
ipt -A PUSHIFY-FWD -j RETURN
ipt -C DOCKER-USER -j PUSHIFY-FWD 2>/dev/null || ipt -I DOCKER-USER 1 -j PUSHIFY-FWD

ipt -N PUSHIFY-IN 2>/dev/null || true
ipt -F PUSHIFY-IN
ipt -A PUSHIFY-IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
ipt -A PUSHIFY-IN -p tcp -m multiport --dports 80,443 -j RETURN
ipt -A PUSHIFY-IN -j DROP
for b in $BRIDGES; do
  ipt -C INPUT -i "$b" -j PUSHIFY-IN 2>/dev/null || ipt -I INPUT 1 -i "$b" -j PUSHIFY-IN
done
echo PUSHIFY_ISOLATION_OK
`;
}

function unitFile(): string {
  return `[Unit]
Description=Pushify shared-runner network isolation
After=docker.service firewalld.service
Wants=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=${RUNNER_ISOLATION_SCRIPT_PATH}

[Install]
WantedBy=multi-user.target
`;
}

/**
 * One shell command that installs the script (+ the boot unit where systemd runs) and applies
 * it. Content goes through base64, so nothing in it is interpreted by the remote shell.
 */
export function applyRunnerIsolationCommand(): string {
  const script = Buffer.from(runnerIsolationScript()).toString('base64');
  const unit = Buffer.from(unitFile()).toString('base64');
  return [
    'mkdir -p /opt/pushify',
    `echo ${script} | base64 -d > ${RUNNER_ISOLATION_SCRIPT_PATH}`,
    `chmod 700 ${RUNNER_ISOLATION_SCRIPT_PATH}`,
    `if [ -d /run/systemd/system ]; then echo ${unit} | base64 -d > /etc/systemd/system/${UNIT_NAME} && systemctl daemon-reload && systemctl enable ${UNIT_NAME} >/dev/null 2>&1; fi`,
    `${RUNNER_ISOLATION_SCRIPT_PATH} 2>&1`,
  ].join(' && ');
}
