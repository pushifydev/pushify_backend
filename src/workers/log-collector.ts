import { eq, and, desc, gte, ilike, inArray, lte, lt } from 'drizzle-orm';
import { db } from '../db';
import { containerLogs } from '../db/schema/container-logs';
import { deployments } from '../db/schema/deployments';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { getSSHConnection, SSHClient } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { environmentVariables } from '../db/schema/projects';
import { createLogMasker, type LogMasker } from '../lib/log-masking';
import { logger } from '../lib/logger';
import { getContainerLogs as getRemoteContainerLogs, isContainerRunning as isRemoteContainerRunning } from './remote-docker';
import { getContainerLogs as getLocalContainerLogs, isContainerRunning as isLocalContainerRunning } from './docker';
import { execCommand } from './shell';

const COLLECTION_INTERVAL = 60000; // 1 minute
const MAX_LINES_PER_CHUNK = 1000;
/** Only for logs whose organization is gone; per-plan retention does the rest. */
const LOG_RETENTION_BACKSTOP_DAYS = 120;
const CLEANUP_INTERVAL = 60 * 60 * 1000; // prune once an hour, not every collection cycle
let lastCleanupAt = 0;

let isRunning = false;

/**
 * Start the log collector worker
 */
export async function startLogCollector(): Promise<void> {
  if (isRunning) {
    logger.warn('Log collector is already running');
    return;
  }

  isRunning = true;
  logger.info('📝 Log collector started');

  collectLogs();
}

/**
 * Stop the log collector worker
 */
export function stopLogCollector(): void {
  isRunning = false;
  logger.info('Log collector stopped');
}

/**
 * Main collection loop
 */
async function collectLogs(): Promise<void> {
  while (isRunning) {
    try {
      await collectAllDeploymentLogs();
      if (Date.now() - lastCleanupAt > CLEANUP_INTERVAL) {
        await cleanupOldLogs();
        lastCleanupAt = Date.now();
      }
    } catch (error) {
      logger.error({ err: error }, 'Error in log collection cycle');
    }

    await sleep(COLLECTION_INTERVAL);
  }
}

/**
 * Collect logs from all running deployments. Exported so one cycle can be run on demand
 * (the e2e does this instead of waiting for the interval).
 */
export async function collectAllDeploymentLogs(): Promise<void> {
  // Get all running deployments
  const runningDeployments = await db
    .select({
      deployment: deployments,
      project: projects,
      server: servers,
    })
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .leftJoin(servers, eq(projects.serverId, servers.id))
    .where(eq(deployments.status, 'running'));

  for (const { deployment, project, server } of runningDeployments) {
    try {
      await collectDeploymentLogs(deployment, project, server);
    } catch (error) {
      logger.error(
        { err: error, deploymentId: deployment.id },
        'Failed to collect logs for deployment'
      );
    }
  }
}

/**
 * Collect logs for a single deployment — from every container the project runs: the app, its
 * replicas, its workers and its staging copy. Only the first container's logs used to be
 * collected, so a replica's or a worker's output was simply lost.
 */
async function collectDeploymentLogs(
  deployment: typeof deployments.$inferSelect,
  project: typeof projects.$inferSelect,
  server: typeof servers.$inferSelect | null
): Promise<void> {
  // A stopped/errored server can't answer SSH — skip instead of burning a
  // handshake timeout and logging an error on every collection tick.
  if (server && server.status !== 'running') return;

  const lastChunk = await db
    .select({ chunkIndex: containerLogs.chunkIndex })
    .from(containerLogs)
    .where(eq(containerLogs.deploymentId, deployment.id))
    .orderBy(desc(containerLogs.chunkIndex))
    .limit(1);
  let chunkIndex = lastChunk.length > 0 ? lastChunk[0].chunkIndex + 1 : 0;

  const collected: Array<{ containerName: string; logs: string }> = [];
  const remote = !!(server && server.ipv4 && server.sshPrivateKey);
  let ssh: SSHClient | null = null;

  try {
    if (remote) {
      ssh = await getSSHConnection({
        host: server!.ipv4!,
        port: 22,
        username: 'root',
        privateKey: decrypt(server!.sshPrivateKey!),
      });
    }

    for (const containerName of await projectContainers(ssh, project.slug)) {
      const running = ssh
        ? await isRemoteContainerRunning(ssh, containerName)
        : await isLocalContainerRunning(containerName);
      if (!running) continue;
      const logs = ssh
        ? await getRemoteContainerLogs(ssh, containerName, { tail: MAX_LINES_PER_CHUNK, since: '1m' })
        : await getLocalContainerLogs(containerName, { tail: MAX_LINES_PER_CHUNK, since: '1m' });
      if (logs && logs.trim().length > 0) collected.push({ containerName, logs });
    }
  } finally {
    if (ssh) ssh.disconnect();
  }

  if (collected.length === 0) return;

  // Apps routinely print env values — mask the project's secrets before persisting.
  const masker = await getProjectLogMasker(project.id);
  for (const entry of collected) {
    const content = masker.mask(entry.logs);
    const lineCount = content.split('\n').filter((line) => line.trim()).length;
    await db.insert(containerLogs).values({
      deploymentId: deployment.id,
      projectId: project.id,
      logContent: content,
      logType: 'stdout',
      containerName: entry.containerName,
      lineCount,
      chunkIndex: chunkIndex++,
      startTimestamp: new Date(Date.now() - 60000), // 1 minute ago
      endTimestamp: new Date(),
    });
  }

  logger.debug(
    { deploymentId: deployment.id, containers: collected.map((entry) => entry.containerName) },
    'Collected container logs'
  );
}

/**
 * The project's containers on that host: the app in whichever blue/green slot it holds, its
 * replicas (`-blue-2`, …), its workers (`-worker-<name>`) and its staging copy.
 */
export async function projectContainers(ssh: SSHClient | null, slug: string): Promise<string[]> {
  const command = `docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^pushify-${slug}(-|$)' || true`;
  const output = ssh ? (await ssh.exec(command)).stdout : (await execCommand(command)).stdout;
  const names: string[] = output
    .split('\n')
    .map((name) => name.trim())
    .filter(Boolean)
    // `pushify-app` must not pick up `pushify-app-2`'s containers, and never a database
    .filter((name) => name === `pushify-${slug}` || name.startsWith(`pushify-${slug}-`))
    .filter((name) => !name.startsWith('pushify-db-'));
  return names.length > 0 ? names : [`pushify-${slug}`];
}

/**
 * Drop logs past each organization's retention (lib/plans.ts `logRetentionDays`): the free tier
 * keeps a few days, paid plans keep more. Anything whose project or organization has gone is
 * cleaned up by the longest retention as a backstop.
 */
async function cleanupOldLogs(): Promise<void> {
  const { getEffectivePlanLimits } = await import('../lib/effective-plan-limits');
  const { organizations } = await import('../db/schema/organizations');

  const orgs = await db
    .select({ id: organizations.id, plan: organizations.plan, grandfatheredUntil: organizations.grandfatheredUntil, overrides: organizations.planLimitsOverride })
    .from(organizations);

  let deleted = 0;
  for (const org of orgs) {
    const limits = getEffectivePlanLimits({
      plan: org.plan ?? 'free',
      grandfatheredUntil: org.grandfatheredUntil,
      planLimitsOverride: org.overrides as Partial<Record<string, number | boolean>> | null,
    });
    const cutoff = new Date(Date.now() - Math.max(1, limits.logRetentionDays) * 24 * 60 * 60 * 1000);
    const rows = await db
      .delete(containerLogs)
      .where(
        and(
          lt(containerLogs.createdAt, cutoff),
          inArray(
            containerLogs.projectId,
            db.select({ id: projects.id }).from(projects).where(eq(projects.organizationId, org.id))
          )
        )
      )
      .returning({ id: containerLogs.id });
    deleted += rows.length;
  }

  // Backstop for logs whose organization no longer exists
  const backstop = new Date(Date.now() - LOG_RETENTION_BACKSTOP_DAYS * 24 * 60 * 60 * 1000);
  const orphans = await db
    .delete(containerLogs)
    .where(lt(containerLogs.createdAt, backstop))
    .returning({ id: containerLogs.id });

  logger.debug({ deleted: deleted + orphans.length }, 'Log cleanup cycle completed');
}

/**
 * Get historical logs for a deployment
 */
export async function getHistoricalLogs(
  deploymentId: string,
  options?: {
    limit?: number;
    offset?: number;
    startTime?: Date;
    endTime?: Date;
  }
): Promise<{
  logs: Array<{
    content: string;
    timestamp: Date;
    lineCount: number;
  }>;
  totalChunks: number;
}> {
  const { limit = 10, offset = 0 } = options || {};

  const chunks = await db
    .select({
      logContent: containerLogs.logContent,
      startTimestamp: containerLogs.startTimestamp,
      lineCount: containerLogs.lineCount,
      chunkIndex: containerLogs.chunkIndex,
    })
    .from(containerLogs)
    .where(eq(containerLogs.deploymentId, deploymentId))
    .orderBy(desc(containerLogs.chunkIndex))
    .limit(limit)
    .offset(offset);

  // Get total count
  const countResult = await db
    .select({ count: containerLogs.id })
    .from(containerLogs)
    .where(eq(containerLogs.deploymentId, deploymentId));

  return {
    logs: chunks.map(chunk => ({
      content: chunk.logContent,
      timestamp: chunk.startTimestamp || new Date(),
      lineCount: chunk.lineCount,
    })),
    totalChunks: countResult.length,
  };
}


/**
 * Search a project's persisted container logs (the 7-day retained chunks). Filters chunks
 * with ILIKE, then extracts matching lines — line-level timestamps aren't stored, so each
 * line carries its chunk's start timestamp. Bounded on both chunks scanned and lines returned.
 */
export async function searchProjectLogs(
  projectId: string,
  options: {
    query?: string;
    logType?: 'stdout' | 'stderr';
    /** One container of the project: the app, a replica, a worker, staging */
    containerName?: string;
    from?: Date;
    to?: Date;
    maxLines?: number;
  }
): Promise<{
  lines: Array<{
    content: string;
    timestamp: Date;
    logType: string;
    deploymentId: string;
    containerName: string | null;
  }>;
  scannedChunks: number;
}> {
  const { query, logType, containerName, from, to, maxLines = 500 } = options;
  const MAX_CHUNKS = 100;

  const conditions = [eq(containerLogs.projectId, projectId)];
  if (logType) conditions.push(eq(containerLogs.logType, logType));
  if (containerName) conditions.push(eq(containerLogs.containerName, containerName));
  if (from) conditions.push(gte(containerLogs.createdAt, from));
  if (to) conditions.push(lte(containerLogs.createdAt, to));
  if (query?.trim()) {
    // Escape LIKE wildcards so user input is a literal substring match
    const escaped = query.trim().replace(/[\\%_]/g, (ch) => `\\${ch}`);
    conditions.push(ilike(containerLogs.logContent, `%${escaped}%`));
  }

  const chunks = await db
    .select({
      logContent: containerLogs.logContent,
      logType: containerLogs.logType,
      startTimestamp: containerLogs.startTimestamp,
      deploymentId: containerLogs.deploymentId,
      containerName: containerLogs.containerName,
    })
    .from(containerLogs)
    .where(and(...conditions))
    .orderBy(desc(containerLogs.startTimestamp))
    .limit(MAX_CHUNKS);

  const needle = query?.trim().toLowerCase();
  const lines: Array<{ content: string; timestamp: Date; logType: string; deploymentId: string; containerName: string | null }> = [];

  for (const chunk of chunks) {
    if (lines.length >= maxLines) break;
    for (const line of chunk.logContent.split('\n')) {
      if (!line.trim()) continue;
      if (needle && !line.toLowerCase().includes(needle)) continue;
      lines.push({
        content: line,
        timestamp: chunk.startTimestamp || new Date(),
        logType: chunk.logType,
        deploymentId: chunk.deploymentId,
        containerName: chunk.containerName,
      });
      if (lines.length >= maxLines) break;
    }
  }

  return { lines, scannedChunks: chunks.length };
}

/**
 * The containers this project has logs for — app, replicas, staging, workers — so the logs
 * explorer can offer them as a filter instead of mixing every container into one stream.
 */
export async function projectLogContainers(projectId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ containerName: containerLogs.containerName })
    .from(containerLogs)
    .where(eq(containerLogs.projectId, projectId));
  return rows
    .map((row) => row.containerName)
    .filter((name): name is string => !!name)
    .sort();
}

/**
 * Get combined logs (historical + live) for a deployment
 */
export async function getCombinedLogs(
  deploymentId: string,
  projectSlug: string,
  serverId: string | null,
  limit: number = 500
): Promise<string> {
  // Get historical logs first
  const historical = await getHistoricalLogs(deploymentId, { limit: 5 });

  // Combine historical logs
  const combinedLogs = historical.logs
    .reverse()
    .map(chunk => chunk.content)
    .join('\n');

  // If we need more lines, get live logs
  const historicalLineCount = combinedLogs.split('\n').length;
  if (historicalLineCount < limit) {
    // Get additional live logs
    // This is handled by the streaming endpoint
  }

  return combinedLogs;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export function isLogCollectorRunning(): boolean {
  return isRunning;
}

// ── Secret masking for persisted runtime logs ────────────────────────────────
const MASKER_TTL_MS = 10 * 60 * 1000;
const maskerCache = new Map<string, { masker: LogMasker; builtAt: number }>();

/** Per-project masker built from decrypted env values; cached to avoid decrypting each tick. */
export async function getProjectLogMasker(projectId: string): Promise<LogMasker> {
  const cached = maskerCache.get(projectId);
  if (cached && Date.now() - cached.builtAt < MASKER_TTL_MS) {
    return cached.masker;
  }

  const envRows = await db
    .select()
    .from(environmentVariables)
    .where(eq(environmentVariables.projectId, projectId));

  const envVars: Record<string, string> = {};
  for (const row of envRows) {
    try {
      envVars[row.key] = decrypt(row.valueEncrypted);
    } catch {
      // skip undecryptable values
    }
  }

  const masker = createLogMasker(envVars);
  maskerCache.set(projectId, { masker, builtAt: Date.now() });
  return masker;
}
