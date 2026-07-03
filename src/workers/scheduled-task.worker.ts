import { execFile } from 'node:child_process';
import { eq, and, lte, lt, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { scheduledTasks, scheduledTaskRuns } from '../db/schema/scheduled-tasks';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { SSHClient } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { resolvePushifyContainerName } from '../lib/container-resolve';
import { resolveProjectServerId } from '../lib/runner-routing';
import { nextCronRun } from '../lib/cron-schedule';
import { assertPublicUrl } from '../lib/ssrf-guard';
import { logger } from '../lib/logger';

const TICK_INTERVAL_MS = 30_000;
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const RUN_RETENTION_DAYS = 7;
/** Max stored output per run */
const OUTPUT_CAP_BYTES = 8_192;
/** Max tasks claimed per tick — backpressure against a thundering herd */
const MAX_CLAIMS_PER_TICK = 20;

type ScheduledTask = typeof scheduledTasks.$inferSelect;

interface RunResult {
  status: 'success' | 'failed' | 'timeout';
  exitCode?: number;
  httpStatus?: number;
  output?: string;
  errorMessage?: string;
}

function capOutput(text: string): string {
  return text.length > OUTPUT_CAP_BYTES ? text.slice(-OUTPUT_CAP_BYTES) : text;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Run the task's command inside the project's app container (remote via SSH, or local). */
async function runCommandTask(task: ScheduledTask): Promise<RunResult> {
  const project = await db.query.projects.findFirst({ where: eq(projects.id, task.projectId) });
  if (!project) {
    return { status: 'failed', errorMessage: 'Project not found' };
  }

  const targetServerId = resolveProjectServerId(project);
  let ssh: SSHClient | null = null;

  try {
    if (targetServerId) {
      const server = await db.query.servers.findFirst({ where: eq(servers.id, targetServerId) });
      if (!server?.ipv4 || !server.sshPrivateKey) {
        return { status: 'failed', errorMessage: 'Deploy server is not configured properly' };
      }
      ssh = new SSHClient();
      await ssh.connect({
        host: server.ipv4,
        port: 22,
        username: 'root',
        privateKey: decrypt(server.sshPrivateKey),
      });
    }

    const containerName = await resolvePushifyContainerName(project.slug, ssh);
    if (!containerName) {
      return {
        status: 'failed',
        errorMessage: 'App container is not running — deploy the project first',
      };
    }

    // `timeout` sends TERM (then the shell reports 124) so a runaway task can't hold the
    // SSH channel / worker slot forever.
    const command = `timeout ${task.timeoutSeconds}s docker exec ${containerName} sh -c ${shellQuote(task.command || '')} 2>&1`;

    if (ssh) {
      const result = await ssh.exec(command);
      const timedOut = result.code === 124;
      return {
        status: timedOut ? 'timeout' : result.code === 0 ? 'success' : 'failed',
        exitCode: result.code,
        output: capOutput(result.stdout + (result.stderr ? `\n${result.stderr}` : '')),
        ...(timedOut ? { errorMessage: `Timed out after ${task.timeoutSeconds}s` } : {}),
      };
    }

    // Local fallback (control plane runs on the deploy host itself)
    return await new Promise<RunResult>((resolve) => {
      execFile(
        'sh',
        ['-c', command],
        { timeout: (task.timeoutSeconds + 10) * 1000, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          const exitCode =
            error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number'
              ? ((error as unknown as { code: number }).code)
              : error
                ? 1
                : 0;
          const timedOut = exitCode === 124;
          resolve({
            status: timedOut ? 'timeout' : exitCode === 0 ? 'success' : 'failed',
            exitCode,
            output: capOutput(String(stdout) + (stderr ? `\n${String(stderr)}` : '')),
            ...(timedOut ? { errorMessage: `Timed out after ${task.timeoutSeconds}s` } : {}),
          });
        }
      );
    });
  } finally {
    ssh?.disconnect();
  }
}

/** GET the task's URL. Success = 2xx. */
async function runHttpTask(task: ScheduledTask): Promise<RunResult> {
  if (!task.httpUrl) {
    return { status: 'failed', errorMessage: 'Task has no URL' };
  }
  try {
    await assertPublicUrl(task.httpUrl);
    const response = await fetch(task.httpUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: { 'User-Agent': 'Pushify-Cron/1.0' },
      signal: AbortSignal.timeout(task.timeoutSeconds * 1000),
    });
    const body = await response.text().catch(() => '');
    return {
      status: response.ok ? 'success' : 'failed',
      httpStatus: response.status,
      output: capOutput(body.slice(0, 2048)),
      ...(response.ok ? {} : { errorMessage: `HTTP ${response.status}` }),
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    return {
      status: isTimeout ? 'timeout' : 'failed',
      errorMessage: isTimeout
        ? `Timed out after ${task.timeoutSeconds}s`
        : error instanceof Error
          ? error.message.slice(0, 500)
          : 'Request failed',
    };
  }
}

/** Execute a task now and record the run. Used by the tick loop and the manual run endpoint. */
export async function executeScheduledTask(
  task: ScheduledTask,
  trigger: 'schedule' | 'manual'
): Promise<RunResult> {
  const startedAt = new Date();
  let result: RunResult;
  try {
    result = task.type === 'command' ? await runCommandTask(task) : await runHttpTask(task);
  } catch (error) {
    result = {
      status: 'failed',
      errorMessage: error instanceof Error ? error.message.slice(0, 500) : 'Task failed',
    };
  }
  const finishedAt = new Date();

  try {
    await db.insert(scheduledTaskRuns).values({
      taskId: task.id,
      projectId: task.projectId,
      status: result.status,
      trigger,
      exitCode: result.exitCode,
      httpStatus: result.httpStatus,
      output: result.output,
      errorMessage: result.errorMessage,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      startedAt,
      finishedAt,
    });
    await db
      .update(scheduledTasks)
      .set({ lastRunAt: startedAt, lastStatus: result.status })
      .where(eq(scheduledTasks.id, task.id));
  } catch (error) {
    logger.error({ err: error, taskId: task.id }, 'Failed to record scheduled task run');
  }

  logger.info(
    { taskId: task.id, projectId: task.projectId, status: result.status, trigger },
    'Scheduled task executed'
  );
  return result;
}

/** Claim and run all due tasks. The CAS on nextRunAt makes each firing single-winner. */
export async function tickScheduledTasks(): Promise<{ ran: number }> {
  const now = new Date();
  const due = await db
    .select()
    .from(scheduledTasks)
    .where(
      and(
        eq(scheduledTasks.enabled, true),
        isNotNull(scheduledTasks.nextRunAt),
        lte(scheduledTasks.nextRunAt, now)
      )
    )
    .limit(MAX_CLAIMS_PER_TICK);

  let ran = 0;
  for (const task of due) {
    const next = nextCronRun(task.schedule, task.timezone);
    // Atomic claim: only the process that moves nextRunAt forward runs this firing.
    const claimed = await db
      .update(scheduledTasks)
      .set({ nextRunAt: next })
      .where(and(eq(scheduledTasks.id, task.id), eq(scheduledTasks.nextRunAt, task.nextRunAt!)))
      .returning({ id: scheduledTasks.id });
    if (claimed.length === 0) continue;

    await executeScheduledTask(task, 'schedule');
    ran++;
  }
  return { ran };
}

export async function pruneScheduledTaskRuns(): Promise<void> {
  const cutoff = new Date(Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await db.delete(scheduledTaskRuns).where(lt(scheduledTaskRuns.startedAt, cutoff));
}

let tickInterval: ReturnType<typeof setInterval> | null = null;
let pruneInterval: ReturnType<typeof setInterval> | null = null;
let isTicking = false;

export function startScheduledTaskWorker(): void {
  if (!tickInterval) {
    tickInterval = setInterval(() => {
      if (isTicking) return;
      isTicking = true;
      tickScheduledTasks()
        .then((res) => {
          if (res.ran > 0) logger.info(res, 'Scheduled task tick ran tasks');
        })
        .catch((error) => logger.error({ err: error }, 'Scheduled task tick failed'))
        .finally(() => {
          isTicking = false;
        });
    }, TICK_INTERVAL_MS);
  }
  if (!pruneInterval) {
    pruneInterval = setInterval(() => {
      pruneScheduledTaskRuns().catch((error) =>
        logger.error({ err: error }, 'Scheduled task run prune failed')
      );
    }, PRUNE_INTERVAL_MS);
  }
  logger.info('⏰ Scheduled task worker started');
}

export function stopScheduledTaskWorker(): void {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  if (pruneInterval) {
    clearInterval(pruneInterval);
    pruneInterval = null;
  }
}
