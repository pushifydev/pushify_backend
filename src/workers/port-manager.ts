import type { SSHClient } from '../utils/ssh';

// Port range for Pushify deployments (3001-4000, allowing 1000 projects per server)
const MIN_PORT = 3001;
const MAX_PORT = 4000;

// File to track port assignments on the server
const PORT_REGISTRY_FILE = '/opt/pushify/port-registry.json';

export interface PortAssignment {
  port: number;
  projectSlug: string;
  assignedAt: string;
}

export interface PortRegistry {
  assignments: PortAssignment[];
}

/**
 * Load the port registry from the server
 */
async function loadRegistry(ssh: SSHClient): Promise<PortRegistry> {
  const result = await ssh.exec(`cat ${PORT_REGISTRY_FILE} 2>/dev/null || echo '{"assignments":[]}'`);

  try {
    return JSON.parse(result.stdout);
  } catch {
    return { assignments: [] };
  }
}

/**
 * Save the port registry to the server
 */
async function saveRegistry(ssh: SSHClient, registry: PortRegistry): Promise<void> {
  // Ensure directory exists
  await ssh.exec('mkdir -p /opt/pushify');

  const content = JSON.stringify(registry, null, 2);
  await ssh.uploadFile(content, PORT_REGISTRY_FILE);
}

export interface PortRange {
  min: number;
  max: number;
}

/**
 * Get ports currently in use on the server: every host port published by a Docker
 * container (containers bind 0.0.0.0, which the old 127.0.0.1-only grep missed)
 * plus every TCP listener on the host (databases, user daemons, compose stacks).
 */
async function getUsedPorts(ssh: SSHClient): Promise<number[]> {
  const dockerResult = await ssh.exec(
    "docker ps --format '{{.Ports}}' 2>/dev/null | grep -oE ':[0-9]+->' | grep -oE '[0-9]+' | sort -u || true"
  );
  const listenResult = await ssh.exec(
    "ss -tln 2>/dev/null | awk 'NR>1 {print $4}' | grep -oE '[0-9]+$' | sort -u || true"
  );

  const ports = new Set<number>();
  for (const raw of [dockerResult.stdout, listenResult.stdout]) {
    for (const line of raw.trim().split('\n')) {
      const p = parseInt(line, 10);
      if (!isNaN(p)) ports.add(p);
    }
  }
  return [...ports];
}

/** Is anything listening on this TCP port right now? */
async function isPortListening(ssh: SSHClient, port: number): Promise<boolean> {
  const result = await ssh.exec(`ss -tln 2>/dev/null | grep -E "[:.]${port}( |$)" || true`);
  return !!result.stdout.trim();
}

/**
 * Host ports published by the project's OWN containers — plain/legacy `pushify-<slug>`,
 * blue-green `pushify-<slug>-blue|-green`, or compose stacks whose project label is
 * exactly `pushify-<slug>` (never a name-prefix match: `app` must not claim `app-2`'s
 * ports). A port held by these is safe to keep using.
 */
async function getPortsOwnedBySlug(ssh: SSHClient, projectSlug: string): Promise<Set<number>> {
  const result = await ssh.exec(
    `docker ps --format '{{.Names}}|{{.Label "com.docker.compose.project"}}|{{.Ports}}' 2>/dev/null || true`
  );
  const owned = new Set<number>();
  const namePattern = new RegExp(`^pushify-${projectSlug}(-blue|-green)?$`);
  for (const line of result.stdout.trim().split('\n')) {
    if (!line) continue;
    const [name = '', composeProject = '', ports = ''] = line.split('|');
    const isOurs = namePattern.test(name) || composeProject === `pushify-${projectSlug}`;
    if (!isOurs) continue;
    for (const match of ports.matchAll(/:(\d+)->/g)) {
      owned.add(parseInt(match[1], 10));
    }
  }
  return owned;
}

/**
 * Can the project keep using this port? Yes if its own containers currently hold it
 * (redeploy while running) or nothing is listening on it (stack is down, port still free).
 */
async function isPortReusable(ssh: SSHClient, port: number, projectSlug: string): Promise<boolean> {
  const owned = await getPortsOwnedBySlug(ssh, projectSlug);
  if (owned.has(port)) return true;
  return !(await isPortListening(ssh, port));
}

/**
 * Get or assign a stable port for a project.
 * Priority: (1) the registry assignment, (2) options.preferredPort (e.g. the port a
 * pre-registry deploy is already running on) — each kept only while the project's own
 * containers hold it or it's otherwise free; a port squatted by someone else is
 * dropped and a fresh one assigned from the range, skipping every port that is
 * registered, published by Docker, or listening on the host.
 */
export async function getOrAssignPort(
  ssh: SSHClient,
  projectSlug: string,
  options?: { range?: PortRange; preferredPort?: number }
): Promise<{ port: number; isNew: boolean }> {
  const range = options?.range ?? { min: MIN_PORT, max: MAX_PORT };
  const registry = await loadRegistry(ssh);

  // Sticky path: keep the previously assigned/used port whenever it's still ours to use
  const existing = registry.assignments.find((a) => a.projectSlug === projectSlug);
  const candidates = [existing?.port, options?.preferredPort].filter(
    (p): p is number => typeof p === 'number' && !isNaN(p)
  );
  for (const candidate of candidates) {
    if (await isPortReusable(ssh, candidate, projectSlug)) {
      if (existing?.port !== candidate || !existing) {
        registry.assignments = registry.assignments.filter((a) => a.projectSlug !== projectSlug);
        registry.assignments.push({
          port: candidate,
          projectSlug,
          assignedAt: new Date().toISOString(),
        });
        await saveRegistry(ssh, registry);
      }
      return { port: candidate, isNew: false };
    }
  }
  if (existing) {
    // Assigned port was taken over by another process — release and reassign
    registry.assignments = registry.assignments.filter((a) => a.projectSlug !== projectSlug);
  }

  // Get currently used ports
  const usedPorts = await getUsedPorts(ssh);
  const assignedPorts = registry.assignments.map((a) => a.port);
  const allUsedPorts = new Set([...usedPorts, ...assignedPorts]);

  // Find next available port
  let port: number | null = null;
  for (let p = range.min; p <= range.max; p++) {
    if (!allUsedPorts.has(p)) {
      port = p;
      break;
    }
  }

  if (port === null) {
    throw new Error(`No available ports in range ${range.min}-${range.max}`);
  }

  // Assign the port
  registry.assignments.push({
    port,
    projectSlug,
    assignedAt: new Date().toISOString(),
  });

  await saveRegistry(ssh, registry);

  return { port, isNew: true };
}

/**
 * Get the assigned port for a project (without assigning a new one)
 */
export async function getAssignedPort(
  ssh: SSHClient,
  projectSlug: string
): Promise<number | null> {
  const registry = await loadRegistry(ssh);
  const assignment = registry.assignments.find((a) => a.projectSlug === projectSlug);
  return assignment?.port ?? null;
}

/**
 * Release a port assignment
 */
export async function releasePort(
  ssh: SSHClient,
  projectSlug: string
): Promise<boolean> {
  const registry = await loadRegistry(ssh);
  const initialLength = registry.assignments.length;

  registry.assignments = registry.assignments.filter((a) => a.projectSlug !== projectSlug);

  if (registry.assignments.length < initialLength) {
    await saveRegistry(ssh, registry);
    return true;
  }

  return false;
}

/**
 * Get all port assignments
 */
export async function getAllAssignments(
  ssh: SSHClient
): Promise<PortAssignment[]> {
  const registry = await loadRegistry(ssh);
  return registry.assignments;
}

/**
 * Check if a specific port is available
 */
export async function isPortAvailable(
  ssh: SSHClient,
  port: number
): Promise<boolean> {
  // Check if port is in valid range
  if (port < MIN_PORT || port > MAX_PORT) {
    return false;
  }

  // Check registry
  const registry = await loadRegistry(ssh);
  const isAssigned = registry.assignments.some((a) => a.port === port);
  if (isAssigned) {
    return false;
  }

  // Check if port is actually in use on the system
  const result = await ssh.exec(`ss -tlnp | grep ":${port} " || true`);
  return !result.stdout.trim();
}

/**
 * Reserve a specific port for a project
 */
export async function reservePort(
  ssh: SSHClient,
  port: number,
  projectSlug: string
): Promise<boolean> {
  const available = await isPortAvailable(ssh, port);
  if (!available) {
    return false;
  }

  const registry = await loadRegistry(ssh);

  // Remove any existing assignment for this project
  registry.assignments = registry.assignments.filter((a) => a.projectSlug !== projectSlug);

  // Add new assignment
  registry.assignments.push({
    port,
    projectSlug,
    assignedAt: new Date().toISOString(),
  });

  await saveRegistry(ssh, registry);
  return true;
}

/**
 * Clean up stale port assignments (ports assigned to projects that no longer have running containers)
 */
export async function cleanupStaleAssignments(
  ssh: SSHClient
): Promise<{ removed: string[]; kept: string[] }> {
  const registry = await loadRegistry(ssh);
  const removed: string[] = [];
  const kept: string[] = [];

  // Get list of running Pushify containers
  const result = await ssh.exec(
    "docker ps --format '{{.Names}}' | grep '^pushify-' || true"
  );
  const runningContainers = new Set(
    result.stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((name) => name.replace('pushify-', ''))
  );

  // Filter assignments
  const validAssignments: PortAssignment[] = [];

  for (const assignment of registry.assignments) {
    if (runningContainers.has(assignment.projectSlug)) {
      validAssignments.push(assignment);
      kept.push(assignment.projectSlug);
    } else {
      removed.push(assignment.projectSlug);
    }
  }

  if (removed.length > 0) {
    registry.assignments = validAssignments;
    await saveRegistry(ssh, registry);
  }

  return { removed, kept };
}

/**
 * Get port usage statistics
 */
export async function getPortStats(
  ssh: SSHClient
): Promise<{
  totalPorts: number;
  usedPorts: number;
  availablePorts: number;
  utilizationPercent: number;
}> {
  const totalPorts = MAX_PORT - MIN_PORT + 1;
  const registry = await loadRegistry(ssh);
  const usedPorts = registry.assignments.length;
  const availablePorts = totalPorts - usedPorts;

  return {
    totalPorts,
    usedPorts,
    availablePorts,
    utilizationPercent: Math.round((usedPorts / totalPorts) * 100),
  };
}
