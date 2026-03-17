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

/**
 * Get ports currently in use on the server (from Docker containers)
 */
async function getUsedPorts(ssh: SSHClient): Promise<number[]> {
  // Get ports from running Docker containers
  const result = await ssh.exec(
    "docker ps --format '{{.Ports}}' 2>/dev/null | grep -oE '127\\.0\\.0\\.1:[0-9]+' | cut -d':' -f2 | sort -u || true"
  );

  if (!result.stdout.trim()) {
    return [];
  }

  return result.stdout
    .trim()
    .split('\n')
    .map((p) => parseInt(p, 10))
    .filter((p) => !isNaN(p));
}

/**
 * Get or assign a port for a project
 * If the project already has a port assigned, return it.
 * Otherwise, find the next available port and assign it.
 */
export async function getOrAssignPort(
  ssh: SSHClient,
  projectSlug: string
): Promise<{ port: number; isNew: boolean }> {
  const registry = await loadRegistry(ssh);

  // Check if project already has a port assigned
  const existing = registry.assignments.find((a) => a.projectSlug === projectSlug);
  if (existing) {
    return { port: existing.port, isNew: false };
  }

  // Get currently used ports
  const usedPorts = await getUsedPorts(ssh);
  const assignedPorts = registry.assignments.map((a) => a.port);
  const allUsedPorts = new Set([...usedPorts, ...assignedPorts]);

  // Find next available port
  let port: number | null = null;
  for (let p = MIN_PORT; p <= MAX_PORT; p++) {
    if (!allUsedPorts.has(p)) {
      port = p;
      break;
    }
  }

  if (port === null) {
    throw new Error(`No available ports in range ${MIN_PORT}-${MAX_PORT}`);
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
