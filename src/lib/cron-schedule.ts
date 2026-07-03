import { Cron } from 'croner';

/**
 * Cron expression helpers for user scheduled tasks. croner is used purely as a parser /
 * next-occurrence calculator — constructing a Cron without a callback never starts a timer.
 */

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** Validate a 5-field cron expression (+ timezone). Returns an error string or null when OK. */
export function validateCronExpression(schedule: string, timezone = 'UTC'): string | null {
  if (!isValidTimezone(timezone)) {
    return `Invalid timezone: ${timezone}`;
  }
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) {
    return 'Schedule must be a 5-field cron expression (minute hour day month weekday)';
  }
  try {
    const next = new Cron(schedule.trim(), { timezone }).nextRun();
    if (!next) return 'Schedule never fires';
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Invalid cron expression';
  }
}

/** Next fire time after `from` (defaults to now), or null when the schedule never fires again. */
export function nextCronRun(schedule: string, timezone = 'UTC', from?: Date): Date | null {
  return new Cron(schedule.trim(), { timezone }).nextRun(from ?? new Date());
}
