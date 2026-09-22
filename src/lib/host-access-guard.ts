import { parse as parseYaml } from 'yaml';

/**
 * What a tenant's container may reach on the host it runs on.
 *
 * On a server the customer owns this is their business — Portainer exists to manage that host's
 * Docker, and mounting the socket into it is the point. On a **shared runner**, where many
 * customers' apps share one box, it is not: the Docker socket is the Docker API, so a container
 * holding it can start a privileged container, read every other tenant's environment variables
 * and step around the network isolation entirely. A `:ro` flag changes nothing — it makes the
 * socket *file* read-only, not the API behind it.
 *
 * So on a shared runner the rule is simply: a container may mount its own project directory and
 * nothing else of the host, and none of the compose directives that hand it the host.
 */

export interface HostAccessContext {
  /** Many customers on one box — the strict rules apply */
  sharedHost: boolean;
  /** `/opt/pushify/apps/<slug>`: the only host directory this project may mount */
  projectDir: string;
}

/** Compose keys that hand a container the host, whatever it mounts. */
const HOST_LEVEL_KEYS: Array<{ key: string; describe: string; deniedValues?: string[] }> = [
  { key: 'privileged', describe: 'privileged: true' },
  { key: 'devices', describe: 'devices:' },
  { key: 'cap_add', describe: 'cap_add:' },
  { key: 'device_cgroup_rules', describe: 'device_cgroup_rules:' },
  { key: 'pid', describe: 'pid: host', deniedValues: ['host'] },
  { key: 'ipc', describe: 'ipc: host', deniedValues: ['host', 'shareable'] },
  { key: 'cgroup', describe: 'cgroup: host', deniedValues: ['host'] },
  { key: 'userns_mode', describe: 'userns_mode: host', deniedValues: ['host'] },
];

/** `security_opt` values that switch a sandbox off rather than tighten it. */
const DENIED_SECURITY_OPTS = ['seccomp=unconfined', 'apparmor=unconfined', 'systempaths=unconfined', 'label=disable'];

function normalizePath(value: string): string {
  const collapsed = value.replace(/\/+$/, '').replace(/\/{2,}/g, '/');
  return collapsed === '' ? '/' : collapsed;
}

/** Is `candidate` the project's own directory, or inside it? */
function insideProjectDir(candidate: string, projectDir: string): boolean {
  const target = normalizePath(candidate);
  const base = normalizePath(projectDir);
  if (target.includes('..')) return false;
  return target === base || target.startsWith(`${base}/`);
}

/**
 * One `volumes:` entry. Named volumes and relative paths live under the project's own directory
 * and are always fine; an absolute host path is only fine when it is the project's own.
 */
export function checkHostMount(spec: string, ctx: HostAccessContext): string | null {
  if (!ctx.sharedHost) return null;
  const value = String(spec).trim();
  if (!value) return null;

  // A Windows-style drive letter can't appear here, so the first colon always splits source:target
  const source = value.split(':')[0];
  if (!source.startsWith('/')) return null; // named volume or a path under the project dir

  if (!insideProjectDir(source, ctx.projectDir)) {
    const what = /docker\.sock$/.test(source) ? "the server's Docker socket" : `the host path ${source}`;
    return `${what} cannot be mounted on a shared runner — that would give the container control of the whole server. Deploy this on a server of your own (Servers → Add existing server).`;
  }
  return null;
}

/** Every `volumes:` entry of a container. Returns the first reason to refuse, or null. */
export function checkVolumes(volumes: string[] | undefined, ctx: HostAccessContext): string | null {
  for (const volume of volumes ?? []) {
    const problem = checkHostMount(volume, ctx);
    if (problem) return problem;
  }
  return null;
}

type ComposeService = Record<string, unknown>;

/** One compose service: its mounts and the directives that give it the host. */
export function checkComposeService(name: string, service: ComposeService, ctx: HostAccessContext): string | null {
  if (!ctx.sharedHost || !service || typeof service !== 'object') return null;

  const where = `service "${name}"`;

  for (const { key, describe, deniedValues } of HOST_LEVEL_KEYS) {
    const value = service[key];
    if (value === undefined || value === null) continue;
    if (deniedValues) {
      if (deniedValues.includes(String(value).toLowerCase())) {
        return `${where} uses ${describe}, which is not allowed on a shared runner. Deploy this on a server of your own.`;
      }
      continue;
    }
    // Presence alone is enough for privileged / devices / cap_add
    if (value === false || (Array.isArray(value) && value.length === 0)) continue;
    return `${where} uses ${describe}, which is not allowed on a shared runner. Deploy this on a server of your own.`;
  }

  const networkMode = service.network_mode === undefined ? '' : String(service.network_mode).toLowerCase();
  if (networkMode === 'host' || networkMode.startsWith('container:')) {
    return `${where} uses network_mode: ${networkMode}, which is not allowed on a shared runner. Deploy this on a server of your own.`;
  }

  const securityOpts = Array.isArray(service.security_opt) ? service.security_opt.map(String) : [];
  for (const option of securityOpts) {
    if (DENIED_SECURITY_OPTS.some((denied) => option.toLowerCase().replace(/\s+/g, '') === denied)) {
      return `${where} turns off a sandbox with security_opt: ${option}, which is not allowed on a shared runner.`;
    }
  }

  // Volumes can be strings or the long form { type, source, target }
  const volumes = Array.isArray(service.volumes) ? service.volumes : [];
  for (const volume of volumes) {
    if (typeof volume === 'string') {
      const problem = checkHostMount(volume, ctx);
      if (problem) return `${where}: ${problem}`;
      continue;
    }
    if (volume && typeof volume === 'object') {
      const entry = volume as { type?: unknown; source?: unknown };
      if (entry.type === 'bind' && typeof entry.source === 'string') {
        const problem = checkHostMount(entry.source, ctx);
        if (problem) return `${where}: ${problem}`;
      }
    }
  }

  return null;
}

/**
 * A whole compose file, before it is written to the server. Unparseable YAML is refused here
 * rather than by `docker compose` three steps later.
 */
export function checkComposeFile(composeYaml: string, ctx: HostAccessContext): string | null {
  if (!ctx.sharedHost) return null;

  let parsed: unknown;
  try {
    parsed = parseYaml(composeYaml);
  } catch (err) {
    return `The compose file is not valid YAML: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!parsed || typeof parsed !== 'object') return 'The compose file is empty';

  const services = (parsed as { services?: unknown }).services;
  if (!services || typeof services !== 'object') return 'The compose file declares no services';

  for (const [name, service] of Object.entries(services as Record<string, unknown>)) {
    const problem = checkComposeService(name, service as ComposeService, ctx);
    if (problem) return problem;
  }

  // Top-level volumes can bind a host path too, through a local driver
  const topLevel = (parsed as { volumes?: Record<string, unknown> }).volumes;
  for (const [name, definition] of Object.entries(topLevel ?? {})) {
    const options = (definition as { driver_opts?: Record<string, unknown> } | null)?.driver_opts;
    const device = options?.device;
    if (typeof device === 'string') {
      const problem = checkHostMount(device, ctx);
      if (problem) return `volume "${name}": ${problem}`;
    }
  }

  return null;
}
