import type { SSHClient } from '../utils/ssh';
import { getAssignedPort, getOrAssignPort, recordPortAssignment, releasePort } from './port-manager';

/**
 * An app without a domain is reached at <server-ip>:<port>. Blue-green gives
 * every deploy's container a new port, so that port can't be the container's: it used to flip
 * (3005 → 3006 → 3005 …) and every link to the app broke on each deploy. The public port is
 * nginx's instead — a fixed port per project, forwarded to whichever container is current — so
 * the URL survives deploys, the switch stays zero-downtime, and the container itself is published
 * on 127.0.0.1 only.
 *
 * The site lives in its own file, `pushify-<slug>.port` (a dot can't occur in a slug, so it can't
 * collide with another project's `pushify-<slug>` domains file), and the public port is kept in
 * the port registry under `<slug>:public`.
 */

const SITES_DIR = '/etc/nginx/sites-available';
const ENABLED_DIR = '/etc/nginx/sites-enabled';

const siteName = (slug: string) => `pushify-${slug}.port`;
const registryKey = (slug: string) => `${slug}:public`;

/** The public port this project is served on, or null when it is served by domain instead. */
export async function assignedPublicPort(ssh: SSHClient, slug: string): Promise<number | null> {
  return getAssignedPort(ssh, registryKey(slug));
}

export function publicPortSiteConfig(slug: string, publicPort: number, containerPorts: number | number[]): string {
  const ports = Array.isArray(containerPorts) ? containerPorts : [containerPorts];
  const upstream = ports.length > 1 ? `pushify_${slug.replace(/[^a-zA-Z0-9]/g, '_')}_port` : null;
  const target = upstream ? `http://${upstream}` : `http://127.0.0.1:${ports[0]}`;
  const upstreamBlock = upstream
    ? `upstream ${upstream} {
    least_conn;
${ports.map((port) => `    server 127.0.0.1:${port} max_fails=2 fail_timeout=10s;`).join('\n')}
    keepalive 16;
}

`
    : '';
  return `# Pushify: ${slug} on its public port (no domain) — generated, rewritten on every deploy
${upstreamBlock}server {
    listen ${publicPort};
    server_name _;
    client_max_body_size 100m;

    location / {
        proxy_pass ${target};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $http_connection;
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
    }
}
`;
}

/**
 * Can this server hold a public port in nginx? nginx has to be running and load sites-enabled,
 * and SELinux must not be enforcing (it only lets nginx bind the http ports, so the reload would
 * fail after the old container had already let go of the port). Anything else keeps the old
 * behaviour: the container publishes its port itself.
 */
export async function canServePublicPort(ssh: SSHClient): Promise<boolean> {
  const result = await ssh.exec(
    `command -v nginx >/dev/null 2>&1 && pgrep -x nginx >/dev/null 2>&1 && ` +
      `nginx -T 2>/dev/null | sed 's/#.*$//' | grep -Eq 'include[[:space:]]+${ENABLED_DIR}/' && ` +
      `[ "$(getenforce 2>/dev/null)" != "Enforcing" ] && echo yes || echo no`
  );
  return result.stdout.trim() === 'yes';
}

/** Does nginx answer on the public port now? (Any HTTP status counts — 000 is "nothing there".) */
export async function publicPortAnswers(ssh: SSHClient, port: number): Promise<boolean> {
  const result = await ssh.exec(`curl -s -o /dev/null -m 5 -w '%{http_code}' http://127.0.0.1:${port}/ || true`);
  return result.stdout.trim() !== '000' && result.stdout.trim() !== '';
}

/**
 * The project's public port: the one it already has, else the port it is reachable on right now
 * (`currentPort`, when one of its containers publishes it — the URL people already use), else a
 * new one. Recorded under `<slug>:public`.
 */
export async function resolvePublicPort(ssh: SSHClient, slug: string, currentPort: number | null): Promise<number> {
  const existing = await getAssignedPort(ssh, registryKey(slug));
  if (existing) return existing;
  if (currentPort) {
    const holder = await containerHoldingPort(ssh, currentPort);
    if (holder && new RegExp(`^pushify-${slug}(-blue|-green)?$`).test(holder)) {
      // Taken over from the app's own container during this deploy — keep the URL people use.
      await recordPortAssignment(ssh, registryKey(slug), currentPort);
      return currentPort;
    }
  }
  const { port } = await getOrAssignPort(ssh, registryKey(slug));
  return port;
}

/** The container publishing `port` on all interfaces, if any (a pre-proxy deploy of the app). */
export async function containerHoldingPort(ssh: SSHClient, port: number): Promise<string | null> {
  const result = await ssh.exec(`docker ps --format '{{.Names}} {{.Ports}}' | grep -E '(0\\.0\\.0\\.0|\\[::\\]|:::):${port}->' | head -1 | cut -d' ' -f1`);
  return result.stdout.trim() || null;
}

/** Write the site and check it (`nginx -t`); the caller reloads. Nothing changes when the check fails. */
export async function writePublicPortProxy(
  ssh: SSHClient,
  slug: string,
  publicPort: number,
  containerPorts: number | number[]
): Promise<{ success: boolean; message: string }> {
  const path = `${SITES_DIR}/${siteName(slug)}`;
  const backup = `${path}.prev`;
  const hadPrevious = (await ssh.exec(`test -f ${path} && cp -f ${path} ${backup} && echo yes || true`)).stdout.trim() === 'yes';

  await ssh.uploadFile(publicPortSiteConfig(slug, publicPort, containerPorts), path);
  await ssh.exec(`ln -sf ${path} ${ENABLED_DIR}/${siteName(slug)}`);

  const test = await ssh.exec('nginx -t 2>&1');
  if (test.code !== 0) {
    if (hadPrevious) await ssh.exec(`cp -f ${backup} ${path}`);
    else await ssh.exec(`rm -f ${ENABLED_DIR}/${siteName(slug)} ${path}`);
    return { success: false, message: `Nginx configuration test failed: ${test.stderr || test.stdout}` };
  }
  await ssh.exec(`rm -f ${backup}`);
  const ports = Array.isArray(containerPorts) ? containerPorts : [containerPorts];
  return { success: true, message: `Public port ${publicPort} → 127.0.0.1:${ports.join(', ')}` };
}

/** The app got a domain, or is being deleted: its public port goes away. Returns the port it had. */
export async function removePublicPortProxy(ssh: SSHClient, slug: string): Promise<number | null> {
  const port = await getAssignedPort(ssh, registryKey(slug));
  await ssh.exec(`rm -f ${ENABLED_DIR}/${siteName(slug)} ${SITES_DIR}/${siteName(slug)} ${SITES_DIR}/${siteName(slug)}.prev`);
  if (port) await releasePort(ssh, registryKey(slug));
  return port;
}
