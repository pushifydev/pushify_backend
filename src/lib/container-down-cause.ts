import { extractLogTail } from './log-tail';
import { assertSafeSlug } from './project-containers';

/**
 * Why an app's container gives no answer, read from the container itself when the health check
 * gets ECONNREFUSED: its Docker state (running / restarting / exited), exit code, restart count,
 * the OOM-killed flag, the TCP ports it really listens on, and its last log lines. "Connection
 * refused" alone only says nothing listens; this says why, with one line on what to do about it.
 * Stored in project_health_state.diagnostics.container (shown on the project page, never mailed).
 */
export type ContainerDownCause =
  /** It stopped and nothing restarted it (a manual `docker stop`, or no restart policy) */
  | 'container_exited'
  /** It keeps crashing: Docker is restarting it, or it restarted many times and is not serving */
  | 'crash_loop'
  /** The kernel killed it for running out of memory */
  | 'oom'
  /** It runs and listens, but not on the port traffic is sent to (or only on 127.0.0.1) */
  | 'port_mismatch'
  /** It runs but listens on no TCP port at all */
  | 'not_listening'
  /** The owner paused the project */
  | 'stopped_by_user'
  /** A platform admin suspended the project */
  | 'suspended';

/** Restarts after which a container that is not serving counts as crash-looping. */
export const CRASH_LOOP_RESTARTS = 3;
/** Runtime log lines kept with the diagnosis. */
export const CONTAINER_LOG_LINES = 50;

export interface ContainerDiagnosis {
  checkedAt: string;
  cause: ContainerDownCause | null;
  /** One actionable line for the project page; null when the container is not the problem */
  hint: string | null;
  /**
   * Docker's State.Status (running, restarting, exited, dead, created, paused), or
   * missing: no app container on the server; unknown: the container could not be inspected.
   */
  state: string;
  name: string | null;
  exitCode: number | null;
  restartCount: number | null;
  oomKilled: boolean | null;
  finishedAt: string | null;
  /** The container port traffic is sent to: the published one, else the project's port */
  configuredPort: number | null;
  /** Ports listened on inside the container and reachable from outside it; null when unread */
  listeningPorts: number[] | null;
  /** Ports listened on only on 127.0.0.1 / ::1 inside the container (unreachable from outside) */
  loopbackPorts: number[] | null;
  /** Last log lines, secrets masked by the caller */
  logTail: string | null;
}

/** What `containerInspectCommand` printed, parsed. */
export interface ContainerInspection {
  state: string;
  name: string | null;
  exitCode: number | null;
  restartCount: number | null;
  oomKilled: boolean | null;
  finishedAt: string | null;
  /** Container port from HostConfig.PortBindings — the one Pushify forwards to */
  publishedPort: number | null;
  listeningPorts: number[] | null;
  loopbackPorts: number[] | null;
  logTail: string | null;
}

const MARK = '@@pushify:';

/**
 * Shell that finds the project's production app container (pushify-<slug>, or its blue/green
 * colour; a running one first, else the newest) and prints its state, the sockets its network
 * namespace listens on (/proc/<pid>/net/tcp — no tools needed inside the image) and its last log
 * lines. Read-only. Never reads the container's environment, which holds the app's secrets.
 */
export function containerInspectCommand(slug: string, logLines: number = CONTAINER_LOG_LINES): string {
  const s = assertSafeSlug(slug);
  const tail = Math.max(1, Math.trunc(logLines));
  const format =
    '{"status":{{json .State.Status}},"exitCode":{{.State.ExitCode}},"oomKilled":{{.State.OOMKilled}},' +
    '"restartCount":{{.RestartCount}},"finishedAt":{{json .State.FinishedAt}},"ports":{{json .HostConfig.PortBindings}}}';
  return [
    `c=$(docker ps -a --format '{{.Names}} {{.Status}}' | grep -E '^pushify-${s}(-(blue|green))? ' || true)`,
    `n=$(printf '%s\\n' "$c" | awk '$2=="Up"{print $1; exit}')`,
    `[ -n "$n" ] || n=$(printf '%s\\n' "$c" | awk 'NF{print $1; exit}')`,
    `if [ -z "$n" ]; then echo '${MARK}none'; exit 0; fi`,
    `echo "${MARK}inspect $n"`,
    `docker inspect --format '${format}' "$n"`,
    `p=$(docker inspect --format '{{.State.Pid}}' "$n" 2>/dev/null)`,
    `echo '${MARK}listen'`,
    `[ "\${p:-0}" -gt 0 ] 2>/dev/null && cat /proc/$p/net/tcp /proc/$p/net/tcp6 2>/dev/null`,
    `echo '${MARK}logs'`,
    `docker logs --tail ${tail} "$n" 2>&1 | tail -c 16000`,
    'true',
  ].join('\n');
}

/** 127.0.0.0/8, ::1 and ::ffff:127.x as /proc/net/tcp{,6} prints them (little-endian words). */
function isLoopbackHex(address: string): boolean {
  const a = address.toUpperCase();
  if (a.length === 8) return a.slice(6, 8) === '7F';
  if (a.length === 32) {
    if (a === '00000000000000000000000001000000') return true;
    return a.startsWith('0000000000000000FFFF0000') && a.slice(30, 32) === '7F';
  }
  return false;
}

/** Listening TCP ports from /proc/<pid>/net/tcp and tcp6, split into reachable and loopback-only. */
export function parseListeningPorts(table: string): { listeningPorts: number[]; loopbackPorts: number[] } {
  const reachable = new Set<number>();
  const loopback = new Set<number>();
  for (const line of table.split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || !/^\d+:$/.test(fields[0]) || fields[3] !== '0A') continue; // 0A = LISTEN
    const [address, portHex] = fields[1].split(':');
    const port = Number.parseInt(portHex ?? '', 16);
    if (!address || !Number.isInteger(port) || port <= 0) continue;
    (isLoopbackHex(address) ? loopback : reachable).add(port);
  }
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  return { listeningPorts: sorted(reachable), loopbackPorts: sorted(loopback).filter((p) => !reachable.has(p)) };
}

function firstPublishedPort(ports: unknown): number | null {
  if (!ports || typeof ports !== 'object') return null;
  for (const key of Object.keys(ports)) {
    const match = /^(\d+)\/tcp$/.exec(key);
    if (match) return Number(match[1]);
  }
  return null;
}

/**
 * Parse what `containerInspectCommand` printed. null when the output is not what it prints
 * (the command did not run); `state: 'missing'` when the server has no app container.
 */
export function parseContainerInspectOutput(stdout: string): ContainerInspection | null {
  const sections: Record<string, string[]> = {};
  let name: string | null = null;
  let current: string | null = null;
  for (const line of stdout.split('\n')) {
    // The log tail is printed last and is the app's own output: no markers are read inside it.
    if (current !== 'logs' && line.startsWith(MARK)) {
      const [key, ...rest] = line.slice(MARK.length).trim().split(' ');
      current = key;
      sections[key] = [];
      if (key === 'inspect') name = rest.join(' ').trim() || null;
      continue;
    }
    if (current) sections[current].push(line);
  }

  if (sections.none) {
    return {
      state: 'missing',
      name: null,
      exitCode: null,
      restartCount: null,
      oomKilled: null,
      finishedAt: null,
      publishedPort: null,
      listeningPorts: null,
      loopbackPorts: null,
      logTail: null,
    };
  }
  if (!sections.inspect) return null;

  let state: { status?: unknown; exitCode?: unknown; oomKilled?: unknown; restartCount?: unknown; finishedAt?: unknown; ports?: unknown };
  try {
    state = JSON.parse(sections.inspect.join('\n').trim());
  } catch {
    return null;
  }
  if (typeof state?.status !== 'string') return null;

  const running = state.status === 'running';
  const listen = sections.listen?.some((l) => l.trim()) ? parseListeningPorts(sections.listen.join('\n')) : null;
  const finishedAt = typeof state.finishedAt === 'string' && !state.finishedAt.startsWith('0001-') ? state.finishedAt : null;
  return {
    state: state.status,
    name,
    // A running container still reports the code of its previous run.
    exitCode: !running && typeof state.exitCode === 'number' ? state.exitCode : null,
    restartCount: typeof state.restartCount === 'number' ? state.restartCount : null,
    oomKilled: typeof state.oomKilled === 'boolean' ? state.oomKilled : null,
    finishedAt,
    publishedPort: firstPublishedPort(state.ports),
    // Only a running container has a network namespace to read.
    listeningPorts: running ? (listen?.listeningPorts ?? null) : null,
    loopbackPorts: running ? (listen?.loopbackPorts ?? null) : null,
    logTail: extractLogTail(sections.logs?.join('\n'), CONTAINER_LOG_LINES) ?? null,
  };
}

/** A paused or suspended project is not down: it was stopped on purpose. */
export function projectStopCause(project: { status: string; suspendedAt?: Date | string | null } | null | undefined): ContainerDownCause | null {
  if (!project) return null;
  if (project.suspendedAt) return 'suspended';
  if (project.status === 'paused') return 'stopped_by_user';
  return null;
}

export function classifyContainerDown(
  inspection: ContainerInspection | null,
  configuredPort: number | null
): ContainerDownCause | null {
  if (!inspection || inspection.state === 'missing' || inspection.state === 'unknown') return null;
  const restarts = inspection.restartCount ?? 0;
  // Docker clears the flag when the container starts again, so it is only set for the last exit.
  if (inspection.oomKilled) return 'oom';
  if (inspection.state === 'restarting') return 'crash_loop';
  if (inspection.state !== 'running') return restarts >= CRASH_LOOP_RESTARTS ? 'crash_loop' : 'container_exited';

  const listening = inspection.listeningPorts;
  if (listening === null || configuredPort === null) return null;
  // It listens where traffic goes: the container is fine, the refusal is in front of it.
  if (listening.includes(configuredPort)) return null;
  if (listening.length > 0 || (inspection.loopbackPorts ?? []).length > 0) return 'port_mismatch';
  return restarts >= CRASH_LOOP_RESTARTS ? 'crash_loop' : 'not_listening';
}

/** The one line the project page shows for a cause. */
export function containerDownHint(
  cause: ContainerDownCause | null,
  facts: Partial<Pick<ContainerDiagnosis, 'exitCode' | 'restartCount' | 'configuredPort' | 'listeningPorts' | 'loopbackPorts'>> = {}
): string | null {
  const exitCode = facts.exitCode ?? null;
  const port = facts.configuredPort ?? null;
  switch (cause) {
    case 'oom':
      return 'The app ran out of memory and was killed. Lower its memory use or give it more memory (a larger plan or server), then redeploy.';
    case 'crash_loop':
      return `The app keeps crashing on start (${facts.restartCount ?? 0} restarts${exitCode !== null ? `, last exit code ${exitCode}` : ''}). Fix the error shown in its last log lines and redeploy.`;
    case 'container_exited':
      return `The app's container stopped${exitCode !== null ? ` (exit code ${exitCode})` : ''} and was not restarted. Check its last log lines, fix the cause and redeploy.`;
    case 'port_mismatch': {
      if (port !== null && (facts.loopbackPorts ?? []).includes(port)) {
        return `The app listens on 127.0.0.1:${port} only, which cannot be reached from outside its container. Bind it to 0.0.0.0 and redeploy.`;
      }
      const actual = facts.listeningPorts?.length ? facts.listeningPorts : (facts.loopbackPorts ?? []);
      return `The app listens on port ${actual.join(', ') || 'another port'} but traffic goes to port ${port ?? 'the configured one'}. Make it listen on the PORT environment variable${port !== null ? ` (${port})` : ''} on 0.0.0.0, or set the project port to ${actual[0] ?? 'the one it uses'}, then redeploy.`;
    }
    case 'not_listening':
      return `The app's container runs but nothing listens on port ${port ?? 'the configured port'} inside it. Make the app listen on 0.0.0.0${port !== null ? `:${port}` : ''} (the PORT environment variable) and check its logs for a start-up error.`;
    case 'stopped_by_user':
      return 'This project was stopped from the dashboard. Resume it to bring the site back.';
    case 'suspended':
      return 'This project is suspended. Contact support to have the suspension reviewed.';
    default:
      return null;
  }
}

/**
 * The diagnosis stored with the health state. `inspection` null means the container could not be
 * inspected (no SSH, timeout); `projectPort` is used when the container publishes no port.
 */
export function diagnoseContainer(input: {
  inspection: ContainerInspection | null;
  projectPort?: number | null;
  now?: Date;
}): ContainerDiagnosis {
  const c = input.inspection;
  const configuredPort = c?.publishedPort ?? input.projectPort ?? null;
  const cause = classifyContainerDown(c, configuredPort);
  const facts = {
    exitCode: c?.exitCode ?? null,
    restartCount: c?.restartCount ?? null,
    configuredPort,
    listeningPorts: c?.listeningPorts ?? null,
    loopbackPorts: c?.loopbackPorts ?? null,
  };
  return {
    checkedAt: (input.now ?? new Date()).toISOString(),
    cause,
    hint: containerDownHint(cause, facts),
    state: c?.state ?? 'unknown',
    name: c?.name ?? null,
    oomKilled: c?.oomKilled ?? null,
    finishedAt: c?.finishedAt ?? null,
    logTail: c?.logTail ?? null,
    ...facts,
  };
}

/**
 * What the project page's health status shows: the stored row plus the cause and its hint. A
 * paused or suspended project is not watched, so a 'down' stored before it stopped is not shown
 * as an outage — its status is 'unknown' and the cause says it was stopped on purpose.
 */
export function withDownCause<T extends { status: string; diagnostics?: { container?: ContainerDiagnosis | null } | null }>(
  state: T,
  project: { status: string; suspendedAt?: Date | string | null }
): T & { cause: ContainerDownCause | null; hint: string | null } {
  const stopped = projectStopCause(project);
  if (stopped) return { ...state, status: 'unknown', cause: stopped, hint: containerDownHint(stopped) };
  const container = state.status === 'down' ? (state.diagnostics?.container ?? null) : null;
  return { ...state, cause: container?.cause ?? null, hint: container?.hint ?? null };
}

/**
 * The facts behind a cause in one clause, for the ops diagnosis: state, exit code, restarts, ports.
 * Never the container name (it carries the project slug) and never the logs.
 */
export function describeContainerDown(d: Pick<ContainerDiagnosis, 'cause' | 'state' | 'exitCode' | 'restartCount' | 'oomKilled' | 'configuredPort' | 'listeningPorts' | 'loopbackPorts'>): string {
  const facts = [
    d.exitCode !== null ? `exit code ${d.exitCode}` : null,
    d.restartCount !== null ? `${d.restartCount} restarts` : null,
    d.oomKilled ? 'OOM-killed' : null,
  ].filter(Boolean);
  const state = `the app container is ${d.state}${facts.length ? ` (${facts.join(', ')})` : ''}`;
  switch (d.cause) {
    case 'port_mismatch': {
      const actual = d.listeningPorts?.length ? d.listeningPorts : (d.loopbackPorts ?? []);
      const where = d.configuredPort !== null && (d.loopbackPorts ?? []).includes(d.configuredPort) ? `127.0.0.1:${d.configuredPort} only` : `port ${actual.join(', ')}`;
      return `${state} but listens on ${where}, while traffic goes to port ${d.configuredPort ?? 'unknown'} (port_mismatch)`;
    }
    case 'not_listening':
      return `${state} but listens on no TCP port; traffic goes to port ${d.configuredPort ?? 'unknown'} (not_listening)`;
    case null:
      return state;
    default:
      return `${state} (${d.cause})`;
  }
}
