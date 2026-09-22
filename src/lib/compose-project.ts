import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

/**
 * A `docker-compose.yml` the customer wrote, in their own repository.
 *
 * The marketplace already deploys stacks, but from compose files we wrote and ship. A customer's
 * file is not ours: it decides which service the world reaches, which ports it publishes, and
 * what it mounts. This module answers those questions before anything runs — together with
 * `lib/host-access-guard.ts`, which refuses the directives that would hand over the host.
 */

/** Read in this order, like `docker compose` itself. */
export const COMPOSE_FILENAMES = ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml'];

export interface ComposeService {
  image?: unknown;
  build?: unknown;
  ports?: unknown;
  [key: string]: unknown;
}

export interface ComposePlan {
  /** The service nginx proxies to */
  service: string;
  /** The port inside that container */
  containerPort: number;
  /** Every service, so ports can be rewritten */
  services: Record<string, ComposeService>;
}

/** `"8080:80"`, `"127.0.0.1:8080:80"`, `"80"`, `{ target: 80, published: 8080 }`, `"80/tcp"`. */
export function containerPortOf(entry: unknown): number | null {
  if (typeof entry === 'number') return Number.isInteger(entry) ? entry : null;
  if (entry && typeof entry === 'object') {
    const target = (entry as { target?: unknown }).target;
    const port = typeof target === 'number' ? target : parseInt(String(target ?? ''), 10);
    return Number.isInteger(port) ? port : null;
  }
  if (typeof entry !== 'string') return null;

  // Strip the protocol, then take the last colon-separated part: that is always the container side
  const withoutProtocol = entry.trim().split('/')[0];
  const last = withoutProtocol.split(':').pop() ?? '';
  // A range ("8000-8010") has no single port to proxy to
  if (last.includes('-')) return null;
  const port = parseInt(last, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/**
 * Which service the world should reach. The customer names it when the file is ambiguous;
 * otherwise the single service that publishes a port is the obvious answer, and anything else
 * is refused with what to set rather than guessed at.
 */
export function planCompose(
  composeYaml: string,
  options: { service?: string | null; port?: number | null } = {}
): { plan: ComposePlan } | { error: string } {
  let parsed: unknown;
  try {
    parsed = parseYaml(composeYaml);
  } catch (err) {
    return { error: `The compose file is not valid YAML: ${err instanceof Error ? err.message : String(err)}` };
  }
  const services = (parsed as { services?: unknown })?.services;
  if (!services || typeof services !== 'object' || Array.isArray(services)) {
    return { error: 'The compose file declares no services' };
  }
  const entries = services as Record<string, ComposeService>;
  const names = Object.keys(entries);
  if (names.length === 0) return { error: 'The compose file declares no services' };

  if (options.service) {
    const service = entries[options.service];
    if (!service) {
      return { error: `The compose file has no service "${options.service}" (it has: ${names.join(', ')})` };
    }
    const port = options.port ?? firstPort(service);
    if (!port) {
      return {
        error: `Service "${options.service}" publishes no port, so there is nothing to serve. Add a ports: entry, or set the port in the project's settings.`,
      };
    }
    return { plan: { service: options.service, containerPort: port, services: entries } };
  }

  const publishing = names.filter((name) => firstPort(entries[name]) !== null);
  if (publishing.length === 1) {
    return {
      plan: { service: publishing[0], containerPort: options.port ?? firstPort(entries[publishing[0]])!, services: entries },
    };
  }
  if (publishing.length === 0) {
    return {
      error: `No service in the compose file publishes a port. Add a ports: entry to the one that serves the site, or name it in the project's settings (services: ${names.join(', ')}).`,
    };
  }
  return {
    error: `More than one service publishes a port (${publishing.join(', ')}). Name the one to serve in the project's settings.`,
  };
}

function firstPort(service: ComposeService | undefined): number | null {
  const ports = Array.isArray(service?.ports) ? service!.ports : [];
  for (const entry of ports) {
    const port = containerPortOf(entry);
    if (port !== null) return port;
  }
  return null;
}

/**
 * The override compose writes beside the customer's file.
 *
 * Their `ports:` are replaced wholesale: the public service is published on the host port nginx
 * proxies, and every other service's published ports are dropped. Left alone, `ports: "5432:5432"`
 * on a database would put it on the internet — on a shared runner that is everyone's problem, and
 * on the customer's own server it is a surprise nobody asked for. Services still reach each other
 * by name on the stack's own network, which is what compose files expect.
 */
export function composePortOverride(
  plan: ComposePlan,
  options: { hostPort: number; bindAddress?: string }
): { yaml: string; dropped: string[] } {
  const bind = options.bindAddress ? `${options.bindAddress}:` : '';
  const services: Record<string, { ports: string[] }> = {
    [plan.service]: { ports: [`${bind}${options.hostPort}:${plan.containerPort}`] },
  };

  const dropped: string[] = [];
  for (const [name, service] of Object.entries(plan.services)) {
    if (name === plan.service) continue;
    if (Array.isArray(service?.ports) && service.ports.length > 0) {
      services[name] = { ports: [] };
      dropped.push(name);
    }
  }

  return {
    yaml: stringifyYaml({ services }),
    dropped,
  };
}
