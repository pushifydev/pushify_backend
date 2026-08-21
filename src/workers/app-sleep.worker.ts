import { eq, and, gte, asc } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { containerMetrics } from '../db/schema/metrics';
import { getSSHConnection } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { resolveProjectServerId } from '../lib/runner-routing';
import { logger } from '../lib/logger';

const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
/** Net traffic (rx+tx delta) under this across the idle window counts as idle.
 *  Sized to swallow health-check chatter (~2KB per probe). */
const IDLE_TRAFFIC_THRESHOLD_BYTES = 500_000;
/** How long a wake start may take before we give up and mark the app sleeping again */
const WAKE_TIMEOUT_MS = 30_000;

type Project = typeof projects.$inferSelect;

function containerPattern(slug: string): string {
  return `^pushify-${slug}(-blue|-green)?$`;
}

/** Run a shell command on the project's host — over SSH for server/runner targets. */
async function execOnProjectHost(
  project: Project,
  command: string
): Promise<{ ok: boolean; stdout: string }> {
  const targetServerId = resolveProjectServerId(project);
  if (targetServerId) {
    const server = await db.query.servers.findFirst({ where: eq(servers.id, targetServerId) });
    if (!server?.ipv4 || !server.sshPrivateKey) {
      return { ok: false, stdout: '' };
    }
    const ssh = await getSSHConnection({
      host: server.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });
    try {
      const result = await ssh.exec(command);
      return { ok: result.code === 0, stdout: result.stdout };
    } finally {
      ssh.disconnect();
    }
  }

  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    execFile('sh', ['-c', command], { timeout: 60_000 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout) });
    });
  });
}

/** Stop the app's container(s) and mark the project sleeping. */
export async function sleepProject(project: Project): Promise<boolean> {
  const stopCmd =
    `docker ps --format '{{.Names}}' | grep -E '${containerPattern(project.slug)}' | ` +
    `xargs -r docker stop --time 15`;
  const result = await execOnProjectHost(project, stopCmd);
  if (!result.ok) {
    logger.warn({ projectId: project.id }, 'Auto-sleep: failed to stop container');
    return false;
  }
  await db
    .update(projects)
    .set({ sleepState: 'sleeping' })
    .where(and(eq(projects.id, project.id), eq(projects.sleepState, 'awake')));
  logger.info({ projectId: project.id, slug: project.slug }, '😴 Project slept (idle)');
  return true;
}

/** Start the app's stopped container(s) and mark the project awake. */
async function startProjectContainer(project: Project): Promise<boolean> {
  const startCmd =
    `docker ps -a --format '{{.Names}}' | grep -E '${containerPattern(project.slug)}' | ` +
    `xargs -r docker start && ` +
    `docker ps --format '{{.Names}}' | grep -qE '${containerPattern(project.slug)}'`;
  const result = await execOnProjectHost(project, startCmd);
  return result.ok;
}

/**
 * Wake a sleeping project. Idempotent under concurrency: only the caller that wins the
 * sleeping→waking CAS actually starts the container; everyone else just observes.
 */
export async function requestWake(projectId: string): Promise<'started' | 'in-progress' | 'awake' | 'failed'> {
  const claimed = await db
    .update(projects)
    .set({ sleepState: 'waking' })
    .where(and(eq(projects.id, projectId), eq(projects.sleepState, 'sleeping')))
    .returning({ id: projects.id });

  if (claimed.length === 0) {
    const current = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
    if (!current) return 'failed';
    return current.sleepState === 'waking' ? 'in-progress' : 'awake';
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) return 'failed';

  const deadline = Date.now() + WAKE_TIMEOUT_MS;
  let ok = false;
  while (!ok && Date.now() < deadline) {
    ok = await startProjectContainer(project);
    if (!ok) await new Promise((r) => setTimeout(r, 2000));
  }

  await db
    .update(projects)
    .set(
      ok
        ? { sleepState: 'awake', lastWakeAt: new Date() }
        : { sleepState: 'sleeping' }
    )
    .where(eq(projects.id, projectId));

  if (ok) {
    logger.info({ projectId, slug: project.slug }, '☀️ Project woken');
    return 'started';
  }
  logger.warn({ projectId, slug: project.slug }, 'Wake failed — container did not start');
  return 'failed';
}

/** Find awake, sleep-enabled projects with no meaningful traffic across their idle window. */
export async function sweepIdleProjects(): Promise<{ slept: number }> {
  const candidates = await db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.sleepEnabled, true),
        eq(projects.sleepState, 'awake'),
        eq(projects.status, 'active')
      )
    );

  let slept = 0;
  for (const project of candidates) {
    const windowStart = new Date(Date.now() - project.sleepAfterMinutes * 60_000);

    // Grace period after a deploy or wake — don't judge idleness on a fresh start.
    if (project.lastWakeAt && project.lastWakeAt > windowStart) continue;

    const rows = await db
      .select({
        rx: containerMetrics.networkRxBytes,
        tx: containerMetrics.networkTxBytes,
      })
      .from(containerMetrics)
      .where(
        and(
          eq(containerMetrics.projectId, project.id),
          gte(containerMetrics.recordedAt, windowStart)
        )
      )
      .orderBy(asc(containerMetrics.recordedAt));

    // Too few samples → container down or metrics gap; don't act on weak signal.
    if (rows.length < 4) continue;

    const first = rows[0];
    const last = rows[rows.length - 1];
    const rxDelta = last.rx - first.rx;
    const txDelta = last.tx - first.tx;
    // Negative delta = container restarted mid-window (counters reset) → treat as active.
    if (rxDelta < 0 || txDelta < 0) continue;
    if (rxDelta + txDelta > IDLE_TRAFFIC_THRESHOLD_BYTES) continue;

    if (await sleepProject(project)) slept++;
  }
  return { slept };
}

let sweepInterval: ReturnType<typeof setInterval> | null = null;
let isSweeping = false;

export function startAppSleepWorker(): void {
  if (sweepInterval) return;
  sweepInterval = setInterval(() => {
    if (isSweeping) return;
    isSweeping = true;
    sweepIdleProjects()
      .then((res) => {
        if (res.slept > 0) logger.info(res, 'Auto-sleep sweep slept idle projects');
      })
      .catch((error) => logger.error({ err: error }, 'Auto-sleep sweep failed'))
      .finally(() => {
        isSweeping = false;
      });
  }, SWEEP_INTERVAL_MS);
  logger.info('💤 Auto-sleep worker started');
}

export function stopAppSleepWorker(): void {
  if (sweepInterval) {
    clearInterval(sweepInterval);
    sweepInterval = null;
  }
}
