import type { DeployFailureBlame } from './deploy-failure-classify';
import type { ServerCheckName, ServerCheckOutcome, ServerDiagnostics } from './app-health';

/**
 * Why a monitored site is down, worked out from what was actually observed — the last health
 * check (HTTP status or the network error behind "fetch failed") and the stored server checks —
 * instead of from the latest deployment alone. A failed build does not take a site down on its
 * own (the previous container keeps serving), so "build failed" is only the diagnosis when the
 * proxy answers but nothing is behind it. Used by the ops signals (pushify-hq) so a down site is
 * reported with the right layer, and so a user-side outage can be told apart from a platform one.
 */
export type SiteDownKind =
  | 'build_failed'
  | 'container_not_running'
  | 'dns_tls'
  | 'unreachable'
  | 'app_error'
  | 'unknown';

export interface SiteDownDiagnosis {
  kind: SiteDownKind;
  /**
   * true: the customer's to fix (their build, their app's own errors, their own server).
   * false: Pushify's (a managed server or shared runner that does not answer).
   * null: the facts do not say (e.g. DNS/TLS, which depends on who owns the domain).
   */
  userSide: boolean | null;
  /** One line with the evidence the kind was taken from. */
  summary: string;
}

export interface SiteDownFacts {
  statusCode: number | null;
  error: string | null;
  hosting: 'byos' | 'managed' | 'shared';
  diagnostics: Pick<ServerDiagnostics, 'checks' | 'failedCheck'> | null;
  latestDeploy: { status: string; blame: DeployFailureBlame | null; label: string | null } | null;
}

/** The proxy (nginx or Cloudflare in front of it) answered, but no app behind it did. */
const NO_UPSTREAM = new Set([502, 503, 504, 521, 523]);

const DNS_PATTERN = /enotfound|eai_again|eai_noname|getaddrinfo|dns/;
const TLS_PATTERN = /cert|tls|ssl|self[_ -]signed|unable_to_verify|depth_zero|altname|hostname\/ip does not match/;

/**
 * Node's fetch throws a bare "fetch failed" for every network error; the reason (ENOTFOUND,
 * ECONNREFUSED, CERT_HAS_EXPIRED, …) is only on `cause.code`. Keep the code — never the cause's
 * message, which carries the host name — so DNS, TLS and refused connections can be told apart.
 */
export function withCauseCode(message: string, error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  const code = typeof cause?.code === 'string' && /^[A-Z0-9_]{2,64}$/.test(cause.code) ? cause.code : null;
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

function outcomeOf(diagnostics: SiteDownFacts['diagnostics'], check: ServerCheckName): ServerCheckOutcome | null {
  return diagnostics?.checks?.find((c) => c.check === check)?.outcome ?? null;
}

export function diagnoseSiteDown(facts: SiteDownFacts): SiteDownDiagnosis {
  const ours = facts.hosting !== 'byos';
  const deploy = facts.latestDeploy;
  const buildFailed = deploy?.status === 'failed';

  if (facts.statusCode && facts.statusCode > 0) {
    const code = facts.statusCode;
    if (NO_UPSTREAM.has(code)) {
      if (buildFailed && deploy?.blame === 'project') {
        return {
          kind: 'build_failed',
          userSide: true,
          summary: `HTTP ${code}: the proxy answers but no app is behind it, and the latest deployment failed (${deploy.label ?? 'build failed'}, project side).`,
        };
      }
      return {
        kind: 'container_not_running',
        userSide: null,
        summary: `HTTP ${code}: the proxy answers but the app container does not.${buildFailed ? ` The latest deployment failed (${deploy?.label ?? 'unknown'}, ${deploy?.blame ?? 'unknown'} side).` : ''}`,
      };
    }
    return {
      kind: 'app_error',
      userSide: true,
      summary: `HTTP ${code}: the app answers with an error of its own; server and proxy work.`,
    };
  }

  const error = (facts.error ?? '').toLowerCase();
  const said = facts.error ? ` (${facts.error})` : '';
  if (DNS_PATTERN.test(error)) {
    return { kind: 'dns_tls', userSide: null, summary: `No HTTP answer${said}: the site's host name does not resolve.` };
  }
  if (TLS_PATTERN.test(error)) {
    return { kind: 'dns_tls', userSide: null, summary: `No HTTP answer${said}: the TLS handshake or certificate failed.` };
  }

  const failed = facts.diagnostics?.failedCheck ?? null;
  if (failed === 'ssh') {
    return {
      kind: 'unreachable',
      userSide: !ours,
      summary: `No HTTP answer${said}: the server does not answer SSH (${outcomeOf(facts.diagnostics, 'ssh')}).`,
    };
  }
  if (failed === 'docker') {
    return {
      kind: 'container_not_running',
      userSide: ours ? false : true,
      summary: `No HTTP answer${said}: the server is up but Docker is not running on it.`,
    };
  }
  if (failed === 'http_port' || failed === 'https_port') {
    const port = failed === 'http_port' ? 80 : 443;
    const outcome = outcomeOf(facts.diagnostics, failed);
    if (outcome === 'refused') {
      return {
        kind: 'container_not_running',
        userSide: ours ? null : true,
        summary: `No HTTP answer${said}: the server is up but nothing listens on port ${port} (proxy not running).`,
      };
    }
    return {
      kind: 'unreachable',
      userSide: !ours,
      summary: `No HTTP answer${said}: port ${port} is not reachable from the internet (${outcome ?? 'failed'}).`,
    };
  }
  if (facts.diagnostics && !failed) {
    return {
      kind: 'container_not_running',
      userSide: null,
      summary: `No HTTP answer${said}: SSH, Docker and ports 80/443 all work, so the app container is not answering.`,
    };
  }
  if (facts.error || facts.statusCode === null) {
    return {
      kind: 'unreachable',
      userSide: null,
      summary: `No HTTP answer${said}; no server checks stored to say which layer.`,
    };
  }
  return { kind: 'unknown', userSide: null, summary: 'No health check result to diagnose from.' };
}
