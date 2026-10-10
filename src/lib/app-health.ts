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

/**
 * Cloudflare sits in front of auto subdomains (and many custom domains), and it answers with its
 * own 52x codes when the origin misbehaves. nginx never sends these itself (an upstream that dies
 * mid-response is a 502 from nginx), so a 52x means Cloudflare reached the server but got
 * something it could not use. "HTTP 520" alone tells a customer nothing; this says what it means.
 * null for every other status.
 */
export function describeEdgeStatus(statusCode: number | null | undefined): string | null {
  switch (statusCode) {
    case 520:
      return 'App returned an empty response (HTTP 520): the server accepted the connection but closed it without a valid HTTP answer. The app most likely crashed or reset the connection mid-request; check its logs. If it persists after a redeploy, the server may have no site configured for this domain on HTTPS.';
    case 521:
      return 'Server refused the connection (HTTP 521): nothing is accepting connections on ports 80/443. Check that the proxy is running and the firewall allows them.';
    case 522:
      return 'Connection to the server timed out (HTTP 522): the server did not answer in time. It may be overloaded, off, or a firewall is dropping the traffic.';
    case 523:
      return 'Server unreachable (HTTP 523): the address this domain points at cannot be reached. Check the DNS record and the server IP.';
    case 524:
      return 'App took too long to answer (HTTP 524): the connection worked but no response came within 100 seconds. A slow request or a stuck app is the usual cause.';
    case 525:
    case 526:
      return `TLS handshake with the server failed (HTTP ${statusCode}): the certificate on the server is missing or invalid for this domain. Re-issue it from the domain settings.`;
    default:
      return null;
  }
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

/**
 * Server diagnostics for an app that gives no HTTP answer at all. "Server unreachable" alone does
 * not tell a customer what to fix, so each layer is checked on its own — SSH (is the machine up
 * and reachable), the Docker daemon (can it run the app) and the proxy ports 80/443 (can traffic
 * get in) — and the first one that fails comes with a concrete next step.
 */
export type ServerCheckName = 'ssh' | 'docker' | 'http_port' | 'https_port';

/**
 * ok: worked. timeout: no answer at all (firewall drop, machine off). refused: the host answered
 * but nothing listens. auth_failed: SSH answered but rejected our key. failed: any other error.
 * skipped: could not be tried (no IP/key, or SSH failed so Docker cannot be asked).
 */
export type ServerCheckOutcome = 'ok' | 'timeout' | 'refused' | 'auth_failed' | 'failed' | 'skipped';

export interface ServerCheck {
  check: ServerCheckName;
  outcome: ServerCheckOutcome;
  /** true / false, or null when the check was skipped */
  ok: boolean | null;
  /** What this outcome most likely means and what to do about it; null when ok or skipped */
  advice: string | null;
}

export interface ServerDiagnostics {
  checkedAt: string;
  checks: ServerCheck[];
  /** The first check that failed, in the order a person would fix them */
  failedCheck: ServerCheckName | null;
  /** The advice of that first failed check */
  advice: string | null;
  /** Managed servers are Pushify's to fix: operations is alerted instead of only the customer */
  managed: boolean;
}

export interface ServerProbeOutcomes {
  ssh: ServerCheckOutcome;
  docker: ServerCheckOutcome;
  httpPort: ServerCheckOutcome;
  httpsPort: ServerCheckOutcome;
}

/** Re-run the diagnostics at most this often while a project stays down without an HTTP answer. */
export const DIAGNOSTICS_REFRESH_MS = 60 * 60 * 1000;

const CHECK_ORDER: ServerCheckName[] = ['ssh', 'docker', 'http_port', 'https_port'];

function adviceFor(check: ServerCheckName, outcome: ServerCheckOutcome): string | null {
  if (outcome === 'ok' || outcome === 'skipped') return null;
  switch (check) {
    case 'ssh':
      if (outcome === 'timeout')
        return 'SSH connection timed out: the server may be powered off or offline, or a firewall is dropping port 22. Check the server in your provider panel and allow inbound TCP 22.';
      if (outcome === 'refused')
        return 'SSH connection refused: the server is up but SSH is not listening on port 22. Start the SSH service (systemctl start ssh) from your provider console.';
      if (outcome === 'auth_failed')
        return "SSH login rejected: Pushify's key is no longer accepted. Re-add the Pushify public key to /root/.ssh/authorized_keys.";
      return 'SSH connection failed: check that the server is running and reachable on port 22.';
    case 'docker':
      return 'Docker is not running on the server, so the app cannot run. Start it with "systemctl start docker" and check "journalctl -u docker" (a full disk is a common cause).';
    case 'http_port':
    case 'https_port': {
      const port = check === 'http_port' ? 80 : 443;
      if (outcome === 'refused')
        return `Nothing is listening on port ${port}: the proxy is down. Check it with "docker ps -a" and restart it, or redeploy the app.`;
      return `Port ${port} is not reachable from the internet: a firewall or security group may be blocking it. Allow inbound TCP ${port}.`;
    }
  }
}

/** Turn raw probe outcomes into what the status API and the alerts show. */
export function buildServerDiagnostics(
  outcomes: ServerProbeOutcomes,
  options: { managed: boolean; now?: Date }
): ServerDiagnostics {
  const byCheck: Record<ServerCheckName, ServerCheckOutcome> = {
    ssh: outcomes.ssh,
    // Docker is asked over SSH: without SSH it is unknown, not broken.
    docker: outcomes.ssh === 'ok' ? outcomes.docker : 'skipped',
    http_port: outcomes.httpPort,
    https_port: outcomes.httpsPort,
  };
  const checks: ServerCheck[] = CHECK_ORDER.map((check) => {
    const outcome = byCheck[check];
    return { check, outcome, ok: outcome === 'skipped' ? null : outcome === 'ok', advice: adviceFor(check, outcome) };
  });
  const firstFailed = checks.find((c) => c.ok === false) ?? null;
  const managedNote = ' This is a Pushify-managed server: our operations team has been alerted.';
  return {
    checkedAt: (options.now ?? new Date()).toISOString(),
    checks,
    failedCheck: firstFailed?.check ?? null,
    advice: firstFailed?.advice ? `${firstFailed.advice}${options.managed ? managedNote : ''}` : null,
    managed: options.managed,
  };
}

/** Should the stored diagnostics be refreshed now? */
export function diagnosticsDue(previous: { checkedAt: string } | null | undefined, now: Date): boolean {
  if (!previous?.checkedAt) return true;
  const at = Date.parse(previous.checkedAt);
  return Number.isNaN(at) || now.getTime() - at >= DIAGNOSTICS_REFRESH_MS;
}

/** Map a socket / SSH error to an outcome. */
export function classifyProbeError(err: unknown): ServerCheckOutcome {
  const e = (err ?? {}) as { code?: string; level?: string; message?: string };
  const code = e.code ?? '';
  const message = (e.message ?? String(err ?? '')).toLowerCase();
  if (e.level === 'client-authentication' || message.includes('authentication')) return 'auth_failed';
  if (code === 'ECONNREFUSED' || message.includes('econnrefused') || message.includes('refused')) return 'refused';
  if (
    ['ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN'].includes(code) ||
    message.includes('timed out') ||
    message.includes('timeout')
  )
    return 'timeout';
  return 'failed';
}
