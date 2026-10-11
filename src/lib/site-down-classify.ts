/**
 * Whose problem a down site is, for the operations signals. The health worker already stores why
 * a site is down (`project_health_state.down_reason`) and which server check failed; this turns
 * that into a blame, so a customer's own server that is off or gone is not reported as a
 * platform outage for weeks.
 *
 * - pushify: a Pushify-managed server (or Pushify's own host) gives no answer — ours to fix.
 * - server:  the customer's own server (BYOS) gives no answer — theirs to fix.
 * - project: the server answers but the app errors, or its last deploy failed.
 * - unknown: no reason stored yet.
 */
export type SiteDownBlame = 'pushify' | 'server' | 'project' | 'unknown';

export interface SiteDownSignals {
  /** server_unreachable | app_error | deploy_failed, or null when not worked out yet */
  downReason: string | null;
  /** The project's server, or null when it has none (it then runs on Pushify's own host) */
  server: { provider: string; managed: boolean } | null;
}

export interface SiteDownClassification {
  blame: SiteDownBlame;
  label: string;
}

export function classifySiteDown(signals: SiteDownSignals): SiteDownClassification {
  switch (signals.downReason) {
    case 'server_unreachable': {
      const byos = !!signals.server && (signals.server.provider === 'self_hosted' || !signals.server.managed);
      return byos
        ? { blame: 'server', label: 'User server unreachable' }
        : { blame: 'pushify', label: 'Managed server unreachable' };
    }
    case 'app_error':
      return { blame: 'project', label: 'App not answering correctly' };
    case 'deploy_failed':
      return { blame: 'project', label: 'Latest deploy failed' };
    default:
      return { blame: 'unknown', label: 'Reason not determined yet' };
  }
}
