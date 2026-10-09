import type { AbuseReason } from '../../db/schema/abuse';
import type { AbuseRules } from './rules';

/**
 * Runtime signals for managed servers and shared runners. Only volumes and counts are used —
 * bytes in and out and how many connections are open — never what flows through them.
 * Each signal is `medium`: one alone never flags; it takes two (or a deploy-scan finding).
 */

export interface RuntimeSample {
  /** Bytes out of the app over the last 24 hours (the larger of container tx and nginx bytes sent) */
  egressBytes: number;
  /** Bytes into the app's containers over the same window (container rx); 0 when unknown */
  ingressBytes: number;
  /** Established connections were at or above the threshold on every sample for the sustained window */
  connectionsSustained: boolean;
  connectionCount: number | null;
}

const GIB = 1024 ** 3;

export function evaluateRuntime(sample: RuntimeSample, rules: AbuseRules): AbuseReason[] {
  const r = rules.runtime;
  const reasons: AbuseReason[] = [];

  if (sample.egressBytes >= r.egressBytes24h) {
    reasons.push({
      ruleId: 'runtime-egress',
      strength: 'medium',
      weight: 25,
      message: `Sent ${(sample.egressBytes / GIB).toFixed(1)} GiB in 24 hours (threshold ${(r.egressBytes24h / GIB).toFixed(0)} GiB)`,
    });
  }

  const hi = Math.max(sample.egressBytes, sample.ingressBytes);
  const lo = Math.min(sample.egressBytes, sample.ingressBytes);
  if (sample.egressBytes >= r.relayMinEgressBytes24h && hi > 0 && lo / hi >= r.relayRatio) {
    reasons.push({
      ruleId: 'runtime-relay',
      strength: 'medium',
      weight: 25,
      message: `Traffic in and out are nearly equal (${(lo / hi).toFixed(2)}) at ${(sample.egressBytes / GIB).toFixed(1)} GiB/day — a relay pattern`,
    });
  }

  if (sample.connectionsSustained) {
    reasons.push({
      ruleId: 'runtime-connections',
      strength: 'medium',
      weight: 25,
      message: `${sample.connectionCount ?? r.connections}+ connections held open for ${r.connectionsSustainedMinutes}+ minutes`,
    });
  }
  return reasons;
}

/**
 * Remembers, per project, since when its connection count has stayed at or above the threshold.
 * In memory on purpose: a restart only delays a signal by the sustained window, and nothing about
 * individual connections is ever stored.
 */
export class ConnectionTracker {
  private since = new Map<string, number>();

  record(projectId: string, count: number, threshold: number, sustainedMs: number, now = Date.now()): boolean {
    if (count < threshold) {
      this.since.delete(projectId);
      return false;
    }
    const start = this.since.get(projectId) ?? now;
    this.since.set(projectId, start);
    return now - start >= sustainedMs;
  }

  forget(projectId: string): void {
    this.since.delete(projectId);
  }
}

/** Parse "<container> <count>" lines from the connection-count command; unknown lines are ignored. */
export function parseConnectionCounts(stdout: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const m = /^(\S+)\s+(\d+)\s*$/.exec(line.trim());
    if (m) counts.set(m[1], (counts.get(m[1]) ?? 0) + Number(m[2]));
  }
  return counts;
}

/**
 * Shell that prints "<container> <established TCP connections>" for each running container whose
 * name matches one of the given app prefixes. Counts only — `ss -H` lines are never printed.
 */
export function connectionCountCommand(slugs: string[]): string {
  const safe = slugs.filter((s) => /^[a-z0-9-]+$/.test(s));
  if (safe.length === 0) return 'true';
  const pattern = `^pushify-(${safe.join('|')})(-(blue|green)(-[0-9]+)?)?$`;
  return [
    `for n in $(docker ps --format '{{.Names}}' | grep -E '${pattern}'); do`,
    `  pid=$(docker inspect -f '{{.State.Pid}}' "$n" 2>/dev/null)`,
    `  [ -n "$pid" ] && [ "$pid" != "0" ] || continue`,
    `  c=$(nsenter -t "$pid" -n ss -Htn state established 2>/dev/null | wc -l)`,
    `  echo "$n $c"`,
    `done`,
  ].join('\n');
}
