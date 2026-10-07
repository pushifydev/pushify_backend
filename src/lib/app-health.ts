/**
 * What a health check result means for a project that is being watched.
 *
 * Monitoring runs for every active project with a URL, not only those with a `health_checks` row,
 * so an app that starts crash-looping after a deploy is noticed. A single failed request is not
 * an outage (a restart, a slow query, a blip): `threshold` consecutive failures are. The state
 * lives in `project_health_state`, so one outage is reported once, and once more when it ends.
 */

export type HealthStatus = 'up' | 'down' | 'unknown';

export interface HealthState {
  status: HealthStatus;
  failCount: number;
  downSince: Date | null;
  notifiedAt: Date | null;
  /** Reminders already sent for the current outage (0 = only the first alert) */
  reminderStep?: number;
}

/**
 * Why an app is down, so the alert says where to look. An HTTP error is the app; no answer at
 * all is the server or the network in front of it — on a customer's own server (BYOS) that is
 * theirs to fix, and an "app crashed" mail sends them to the wrong place.
 */
export type DownReason = 'server_unreachable' | 'app_error' | 'deploy_failed';

export interface DownReasonSignals {
  statusCode?: number | null;
  error?: string | null;
  /** The project's most recent deployment failed */
  latestDeployFailed?: boolean;
  /** SSH to the project's server worked (true), failed (false) or was not tried (undefined) */
  serverReachable?: boolean;
}

export function classifyDownReason(signals: DownReasonSignals): DownReason {
  if (signals.latestDeployFailed) return 'deploy_failed';
  // Any HTTP status means something on the server answered: the app is the problem.
  if (signals.statusCode && signals.statusCode > 0) return 'app_error';
  // No HTTP answer, but we can still log into the server: the app is hung or not listening.
  if (signals.serverReachable === true) return 'app_error';
  return 'server_unreachable';
}

/** Reminders while an outage lasts, counted from when it was confirmed. Never more than these. */
export const DOWN_REMINDER_AFTER_MS = [24 * 60 * 60 * 1000, 72 * 60 * 60 * 1000] as const;

/** How many reminder thresholds an outage of this length has passed (0..DOWN_REMINDER_AFTER_MS.length). */
export function dueReminderStep(downSince: Date | null, now: Date): number {
  if (!downSince) return 0;
  const downFor = now.getTime() - downSince.getTime();
  return DOWN_REMINDER_AFTER_MS.filter((after) => downFor >= after).length;
}

export interface HealthCheckResult {
  healthy: boolean;
  statusCode?: number;
  error?: string;
}

export interface HealthTransition {
  state: HealthState;
  /**
   * 'down' the moment it is confirmed down, 'reminder' at 24h and 72h if it is still down,
   * 'up' when it answers again after being down
   */
  notify: 'down' | 'reminder' | 'up' | null;
  /** How long it had been down, for the recovery and reminder messages */
  downForMs: number | null;
}

export function nextHealthState(
  previous: HealthState,
  result: HealthCheckResult,
  threshold: number,
  now: Date = new Date()
): HealthTransition {
  if (result.healthy) {
    const wasDown = previous.status === 'down';
    return {
      state: { status: 'up', failCount: 0, downSince: null, notifiedAt: null, reminderStep: 0 },
      notify: wasDown && previous.notifiedAt ? 'up' : null,
      downForMs: wasDown && previous.downSince ? now.getTime() - previous.downSince.getTime() : null,
    };
  }

  const failCount = previous.failCount + 1;
  const confirmed = failCount >= Math.max(1, threshold);
  const downSince = previous.downSince ?? (confirmed ? now : null);
  const previousStep = previous.reminderStep ?? 0;
  // Tell them once per outage; a check that keeps failing doesn't keep mailing — only a reminder
  // at 24h and 72h. If several thresholds passed at once (worker was off), one reminder covers them.
  let notify: HealthTransition['notify'] = null;
  let reminderStep = previousStep;
  if (confirmed && !previous.notifiedAt) {
    notify = 'down';
    reminderStep = 0;
  } else if (confirmed && previous.notifiedAt) {
    const due = dueReminderStep(downSince, now);
    if (due > previousStep) {
      notify = 'reminder';
      reminderStep = due;
    }
  }
  return {
    state: {
      status: confirmed ? 'down' : previous.status === 'down' ? 'down' : previous.status,
      failCount,
      downSince,
      notifiedAt: notify ? now : previous.notifiedAt,
      reminderStep,
    },
    notify,
    downForMs: notify === 'reminder' && downSince ? now.getTime() - downSince.getTime() : null,
  };
}

/** "4 minutes" / "1 hour 5 minutes" — for the recovery message. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000));
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} hour${hours === 1 ? '' : 's'} ${rest} minute${rest === 1 ? '' : 's'}` : `${hours} hour${hours === 1 ? '' : 's'}`;
}
