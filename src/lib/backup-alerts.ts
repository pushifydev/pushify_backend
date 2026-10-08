/**
 * When a database backup is worth telling someone about.
 *
 * Backups used to report their outcome only on the database page (websocket + row status). A
 * backup that failed at 3am, or one that never started because the worker was down, stayed
 * silent until somebody needed a restore. These events go out through the project notification
 * channels (Slack, Discord, email, webhook) of every project the database is connected to; a
 * channel opts in by listing the event, like any other.
 */
import { MIN_BACKUP_INTERVAL_HOURS } from './backup-schedule';

export const BACKUP_EVENTS = {
  /** A backup finished and its off-site copy (if configured) made it */
  success: 'backup.success',
  /** A backup did not produce a dump — or never started, or hung */
  failed: 'backup.failed',
  /** The dump exists, but only on the database's own server: the off-site copy failed */
  warning: 'backup.warning',
  /** No successful backup for well past the configured interval */
  missed: 'backup.missed',
} as const;

export type BackupEvent = (typeof BACKUP_EVENTS)[keyof typeof BACKUP_EVENTS];

/**
 * A backup row still `creating` after this long is not going to finish: the process that ran it
 * died (deploy, crash) and nothing will ever update the row. Dumps of the databases we host take
 * minutes; two hours is generous.
 */
export const BACKUP_STUCK_AFTER_MS = 2 * 60 * 60 * 1000;

/**
 * How late a backup may be before the missed-backup alarm fires, as a multiple of the interval.
 * One full interval of slack absorbs a single failed or slow run (which `backup.failed` already
 * reported) and the worker's poll granularity; past that, backups have stopped happening.
 */
export const MISSED_BACKUP_GRACE_FACTOR = 2;

/** The event a finished backup reports, given what happened to its off-site copy. */
export function completedBackupEvent(offsiteStatus: string | null | undefined): BackupEvent {
  return offsiteStatus === 'failed' ? BACKUP_EVENTS.warning : BACKUP_EVENTS.success;
}

/** Has this `creating` backup been running for longer than any real dump takes? */
export function isBackupStuck(startedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() - startedAt.getTime() >= BACKUP_STUCK_AFTER_MS;
}

/**
 * Has the expected backup failed to arrive? Measured from the last successful backup, or — for
 * a database that has never had one — from when it was created, so a new database gets the same
 * grace instead of alarming on its first poll.
 */
export function isBackupOverdue(
  lastBackupAt: Date | null | undefined,
  createdAt: Date,
  intervalHours: number | null | undefined,
  now: Date = new Date()
): boolean {
  const hours = Math.max(MIN_BACKUP_INTERVAL_HOURS, Math.round(intervalHours || 24));
  const since = lastBackupAt ?? createdAt;
  return now.getTime() - since.getTime() >= hours * MISSED_BACKUP_GRACE_FACTOR * 60 * 60 * 1000;
}
