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
}

export interface HealthCheckResult {
  healthy: boolean;
  statusCode?: number;
  error?: string;
}

export interface HealthTransition {
  state: HealthState;
  /** 'down' the moment it is confirmed down, 'up' when it answers again after being down */
  notify: 'down' | 'up' | null;
  /** How long it had been down, for the recovery message */
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
      state: { status: 'up', failCount: 0, downSince: null, notifiedAt: null },
      notify: wasDown && previous.notifiedAt ? 'up' : null,
      downForMs: wasDown && previous.downSince ? now.getTime() - previous.downSince.getTime() : null,
    };
  }

  const failCount = previous.failCount + 1;
  const confirmed = failCount >= Math.max(1, threshold);
  const downSince = previous.downSince ?? (confirmed ? now : null);
  // Tell them once per outage; a check that keeps failing doesn't keep mailing.
  const notify = confirmed && !previous.notifiedAt ? 'down' : null;
  return {
    state: {
      status: confirmed ? 'down' : previous.status === 'down' ? 'down' : previous.status,
      failCount,
      downSince,
      notifiedAt: notify ? now : previous.notifiedAt,
    },
    notify,
    downForMs: null,
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
