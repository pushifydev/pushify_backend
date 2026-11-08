import { and, eq, inArray, ne } from 'drizzle-orm';
import type { Queue } from 'bullmq';
import { db } from '../db';
import { deployments } from '../db/schema/deployments';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { getServerPatchQueue, type ServerPatchJobData } from './queue';
import type { PatchUnknown } from './server-patch-status';

/**
 * Scheduled automatic security updates of a server (opt-in, off by default).
 *
 * The schedule is a BullMQ job scheduler on the server-patches queue (one per server, id
 * `auto-patch-<serverId>`, cron in UTC). Each run goes through the same worker and the same
 * `applySecurityPatches` as POST /servers/:serverId/patches/apply: security updates only, Docker /
 * containerd never upgraded, never reboots. Before it runs, the worker checks that the setting is
 * still on, that it is inside the maintenance window and that no deploy is going on on the server
 * (then it is put off by AUTO_PATCH_DEFER_MS, as long as the window lasts).
 */

export const AUTO_PATCH_SCHEDULES = ['off', 'daily', 'weekly'] as const;
export type AutoPatchSchedule = (typeof AUTO_PATCH_SCHEDULES)[number];

export interface AutoPatchSettings {
  autoPatch: AutoPatchSchedule;
  /** Hour (UTC, 0-23) the maintenance window starts */
  autoPatchHour: number;
  /** Weekly runs only: day of the week (UTC), 0 = Sunday … 6 = Saturday */
  autoPatchWeekday: number;
}

export const DEFAULT_AUTO_PATCH_HOUR = 3;
export const DEFAULT_AUTO_PATCH_WEEKDAY = 0;

/** A scheduled run only starts inside this window, from autoPatchHour:00 UTC. */
export const AUTO_PATCH_WINDOW_MINUTES = 60;
/** How long a run waits when a deploy is going on on the server. */
export const AUTO_PATCH_DEFER_MS = 10 * 60 * 1000;

/** Deploy states that count as "a deploy is going on" (as in dashboard / project transfer). */
export const DEPLOY_IN_PROGRESS_STATUSES = ['pending', 'building', 'deploying'] as const;

export const AUTO_PATCH_JOB_NAME = 'auto-apply';
const SCHEDULER_PREFIX = 'auto-patch-';

/** Outcome of the last scheduled run, kept on the server row and shown in the health report. */
export interface ServerAutoPatchLastRun {
  /** When the run ended (ISO) */
  at: string;
  status: 'applied' | 'failed' | 'skipped';
  /** Packages upgraded. Null on dnf (it picks them itself) and when nothing ran */
  packagesApplied: number | null;
  /** Null when nothing ran */
  rebootRequired: boolean | PatchUnknown | null;
  /** applied: the same one-line summary as on the timeline */
  summary: string | null;
  /** failed / skipped: why */
  error: string | null;
  /** failed: PatchApplyError code (or SSH_ERROR); skipped: DEPLOY_IN_PROGRESS */
  code: string | null;
}

export function isAutoPatchSchedule(value: unknown): value is AutoPatchSchedule {
  return typeof value === 'string' && (AUTO_PATCH_SCHEDULES as readonly string[]).includes(value);
}

/** Settings as stored, with anything unexpected read as "off". */
export function toAutoPatchSettings(row: {
  autoPatch: string;
  autoPatchHour: number;
  autoPatchWeekday: number;
}): AutoPatchSettings {
  return {
    autoPatch: isAutoPatchSchedule(row.autoPatch) ? row.autoPatch : 'off',
    autoPatchHour: row.autoPatchHour,
    autoPatchWeekday: row.autoPatchWeekday,
  };
}

export function autoPatchSchedulerId(serverId: string): string {
  // No ':' in it: BullMQ builds the run's job id as `repeat:<schedulerId>:<millis>`
  return `${SCHEDULER_PREFIX}${serverId}`;
}

/** Cron pattern (UTC) of the schedule, null when it is off. */
export function autoPatchCronPattern(settings: AutoPatchSettings): string | null {
  if (settings.autoPatch === 'daily') return `0 ${settings.autoPatchHour} * * *`;
  if (settings.autoPatch === 'weekly') return `0 ${settings.autoPatchHour} * * ${settings.autoPatchWeekday}`;
  return null;
}

/**
 * End of the maintenance window `now` falls in, or null when `now` is outside every window (or the
 * schedule is off). The window never crosses midnight (it starts on the hour and lasts 60 minutes),
 * so the weekday is the one of `now`.
 */
export function autoPatchWindowEnd(now: Date, settings: AutoPatchSettings): Date | null {
  if (settings.autoPatch === 'off') return null;
  if (settings.autoPatch === 'weekly' && now.getUTCDay() !== settings.autoPatchWeekday) return null;
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), settings.autoPatchHour);
  const end = start + AUTO_PATCH_WINDOW_MINUTES * 60 * 1000;
  return now.getTime() >= start && now.getTime() < end ? new Date(end) : null;
}

export function isWithinAutoPatchWindow(now: Date, settings: AutoPatchSettings): boolean {
  return autoPatchWindowEnd(now, settings) !== null;
}

/** A deploy of a project on this server is queued or running. */
export async function hasDeployInProgress(serverId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: deployments.id })
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(and(eq(projects.serverId, serverId), inArray(deployments.status, [...DEPLOY_IN_PROGRESS_STATUSES])))
    .limit(1);
  return !!row;
}

type SchedulerQueue = Pick<Queue<ServerPatchJobData>, 'upsertJobScheduler' | 'removeJobScheduler' | 'getJobSchedulers'>;

/**
 * Write (or remove, when off) the server's job scheduler. False without Redis. Throws when Redis
 * does: callers enabling the schedule must not store a setting nothing will run.
 */
export async function syncServerAutoPatchSchedule(
  server: { id: string; organizationId: string } & AutoPatchSettings,
  queue: SchedulerQueue | null = getServerPatchQueue()
): Promise<boolean> {
  if (!queue) return false;
  const schedulerId = autoPatchSchedulerId(server.id);
  const pattern = autoPatchCronPattern(server);
  if (!pattern) {
    await queue.removeJobScheduler(schedulerId);
    return true;
  }
  await queue.upsertJobScheduler(
    schedulerId,
    { pattern, tz: 'UTC' },
    {
      name: AUTO_PATCH_JOB_NAME,
      data: { serverId: server.id, organizationId: server.organizationId, requestedBy: null, trigger: 'auto' },
    }
  );
  return true;
}

/** Remove the server's job scheduler, if any. */
export async function removeServerAutoPatchSchedule(
  serverId: string,
  queue: SchedulerQueue | null = getServerPatchQueue()
): Promise<void> {
  if (!queue) return;
  await queue.removeJobScheduler(autoPatchSchedulerId(serverId));
}

/**
 * Make the job schedulers match the servers table (worker start): one for every server with the
 * setting on, none for the others (deleted or turned off while Redis was not reachable).
 */
export async function reconcileAutoPatchSchedules(
  queue: SchedulerQueue | null = getServerPatchQueue()
): Promise<{ scheduled: number; removed: number }> {
  if (!queue) return { scheduled: 0, removed: 0 };

  const rows = await db
    .select({
      id: servers.id,
      organizationId: servers.organizationId,
      autoPatch: servers.autoPatch,
      autoPatchHour: servers.autoPatchHour,
      autoPatchWeekday: servers.autoPatchWeekday,
    })
    .from(servers)
    .where(ne(servers.autoPatch, 'off'));

  const wanted = new Set<string>();
  for (const row of rows) {
    const settings = toAutoPatchSettings(row);
    if (settings.autoPatch === 'off') continue;
    await syncServerAutoPatchSchedule({ id: row.id, organizationId: row.organizationId, ...settings }, queue);
    wanted.add(autoPatchSchedulerId(row.id));
  }

  let removed = 0;
  for (const scheduler of await queue.getJobSchedulers(0, -1)) {
    if (scheduler.key.startsWith(SCHEDULER_PREFIX) && !wanted.has(scheduler.key)) {
      await queue.removeJobScheduler(scheduler.key);
      removed++;
    }
  }

  return { scheduled: wanted.size, removed };
}
