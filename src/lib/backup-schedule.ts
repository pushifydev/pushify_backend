/**
 * When a database's next automatic backup is due, and how often it is allowed to be.
 *
 * The interval is the customer's worst-case data loss. It used to be hardcoded at 24 hours for
 * everyone, which means a disk failure costs a day of writes — fine for a side project, not fine
 * for anything with customers of its own.
 */

/** Anything outside this is a mistake rather than a preference. */
export const MIN_BACKUP_INTERVAL_HOURS = 1;
export const MAX_BACKUP_INTERVAL_HOURS = 168; // a week

export interface BackupIntervalLimits {
  /** The shortest interval this organization's plan allows */
  minBackupIntervalHours: number;
}

/**
 * The interval to store, or the reason it was refused. A plan floor exists because an hourly
 * backup costs storage and load on the database itself — it is what a paid plan buys, not a
 * switch everyone should flip.
 */
export function resolveBackupInterval(
  requestedHours: number,
  limits: BackupIntervalLimits
): { hours: number } | { error: string } {
  if (!Number.isFinite(requestedHours)) return { error: 'Backup interval must be a number of hours' };
  const hours = Math.round(requestedHours);

  if (hours < MIN_BACKUP_INTERVAL_HOURS || hours > MAX_BACKUP_INTERVAL_HOURS) {
    return { error: `Backup interval must be between ${MIN_BACKUP_INTERVAL_HOURS} and ${MAX_BACKUP_INTERVAL_HOURS} hours` };
  }
  if (hours < limits.minBackupIntervalHours) {
    return {
      error: `Your plan backs up at most every ${limits.minBackupIntervalHours} hours. Upgrade for more frequent backups.`,
    };
  }
  return { hours };
}

/**
 * Is a backup due? A database that has never been backed up is always due — that is the window
 * where there is nothing to restore from at all, so it should not wait for the first interval
 * to elapse.
 */
export function isBackupDue(
  lastBackupAt: Date | null | undefined,
  intervalHours: number | null | undefined,
  now: Date = new Date()
): boolean {
  if (!lastBackupAt) return true;
  const hours = Math.max(MIN_BACKUP_INTERVAL_HOURS, Math.round(intervalHours || 24));
  return now.getTime() - lastBackupAt.getTime() >= hours * 60 * 60 * 1000;
}

/** How much data a database would lose right now, in the worst case — what the interval means. */
export function worstCaseDataLoss(intervalHours: number | null | undefined): string {
  const hours = Math.max(MIN_BACKUP_INTERVAL_HOURS, Math.round(intervalHours || 24));
  if (hours === 1) return 'up to 1 hour';
  if (hours < 24) return `up to ${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'up to 1 day' : `up to ${days} days`;
}
