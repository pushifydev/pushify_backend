import { env } from '../config/env';
import { TRAFFIC_LOG_DIR } from '../workers/nginx-manager';

/**
 * Per-app traffic analytics: hourly request count, 2xx/3xx/4xx/5xx, bytes sent and a request-time
 * histogram (for p95), taken from each app's own Nginx access log
 * (`TRAFFIC_LOG_DIR/<projectId>.log`, `combined` + `$request_time`, see nginx-manager).
 *
 * The log is aggregated on the server with awk, so only a few lines per app per hour cross the
 * SSH connection, and the raw log is deleted once its totals are stored. Nothing identifying a
 * visitor (IP, path, user agent) leaves the server.
 */

/** How long hourly rows are kept. The longest range served is 7 days. */
export const TRAFFIC_RETENTION_DAYS = 14;

export const TRAFFIC_RANGES = { '24h': 24, '7d': 24 * 7 } as const;
export type TrafficRange = keyof typeof TRAFFIC_RANGES;

/**
 * Upper bounds (ms, inclusive) of the request-time histogram. A histogram has one more slot than
 * there are bounds: the last counts everything slower than the last bound.
 */
export const TRAFFIC_LATENCY_BUCKETS_MS = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000] as const;
const BUCKET_COUNT = TRAFFIC_LATENCY_BUCKETS_MS.length + 1;

const HOUR_MS = 60 * 60 * 1000;

/** On unless switched off globally (TRAFFIC_ANALYTICS_ENABLED=false) or for this project. */
export function isTrafficAnalyticsEnabledFor(settings: Record<string, unknown> | null | undefined): boolean {
  if (!env.TRAFFIC_ANALYTICS_ENABLED) return false;
  return settings?.trafficAnalytics !== false;
}

export function parseTrafficRange(value: string | undefined): TrafficRange | null {
  if (value === undefined || value === '') return '24h';
  return Object.prototype.hasOwnProperty.call(TRAFFIC_RANGES, value) ? (value as TrafficRange) : null;
}

/**
 * Phase 1, run on the server: move every non-empty log aside, tell nginx to reopen its logs
 * (so new requests go to a fresh file), then print per-file hourly totals:
 *   #FILE <name>
 *   <projectId>\t<dd/Mon/yyyy:HH +zzzz>\t<requests>\t<2xx>\t<3xx>\t<4xx>\t<5xx>\t<bytes>\t<h1,h2,…>
 * The last column is the request-time histogram (see TRAFFIC_LATENCY_BUCKETS_MS). Lines without
 * a request time (logs written in plain `combined`) are counted but stay out of the histogram.
 * Files are only deleted by phase 2, after the totals are stored — a failed run is retried.
 */
export function buildTrafficCollectCommand(): string {
  const bounds = TRAFFIC_LATENCY_BUCKETS_MS.join(' ');
  const awk = `awk -F'"' -v id="$id" -v bounds="${bounds}" 'BEGIN { nb = split(bounds, ub, " ") }
{
  i = index($1, "["); if (!i) next
  k = substr($1, i + 1, 14) " " substr($1, i + 22, 5)
  split($3, a, " "); s = a[1] + 0
  n[k]++; b[k] += a[2] + 0
  if (s >= 500) e5[k]++; else if (s >= 400) e4[k]++; else if (s >= 300) e3[k]++; else if (s >= 200) e2[k]++
  t = $NF; gsub(/[ \\t\\r]/, "", t)
  if (NF >= 7 && t ~ /^[0-9]+(\\.[0-9]+)?$/) { ms = t * 1000; j = 1; while (j <= nb && ms > ub[j] + 0) j++; h[k, j]++ }
} END { for (k in n) { hs = ""; for (j = 1; j <= nb + 1; j++) hs = hs (j > 1 ? "," : "") sprintf("%.0f", h[k, j]); printf "%s\\t%s\\t%.0f\\t%.0f\\t%.0f\\t%.0f\\t%.0f\\t%.0f\\t%s\\n", id, k, n[k], e2[k], e3[k], e4[k], e5[k], b[k], hs } }'`;
  return `D=${TRAFFIC_LOG_DIR}
[ -d "$D" ] || exit 0
cd "$D" || exit 0
TS=$(date +%s)
moved=0
for f in *.log; do
  [ -s "$f" ] || continue
  mv -f -- "$f" "\${f%.log}.$TS.collect" && moved=1
done
if [ "$moved" = 1 ]; then
  if [ -s /run/nginx.pid ]; then kill -USR1 "$(cat /run/nginx.pid)" 2>/dev/null || nginx -s reopen; else nginx -s reopen; fi
  sleep 2
fi
for f in *.collect; do
  [ -f "$f" ] || continue
  id="\${f%%.*}"
  echo "#FILE $f"
  ${awk} "$f"
done`;
}

const COLLECT_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.\d+\.collect$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Phase 2: delete the files whose totals were stored. Names are re-validated before use. */
export function buildTrafficCleanupCommand(files: string[]): string | null {
  const safe = files.filter((f) => COLLECT_FILE_RE.test(f));
  if (safe.length === 0) return null;
  return `cd ${TRAFFIC_LOG_DIR} && rm -f -- ${safe.join(' ')}`;
}

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/** "08/Oct/2026:13 +0300" → the UTC hour it falls in, or null when malformed. */
export function parseLogHour(key: string): Date | null {
  const m = /^(\d{2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(key);
  if (!m) return null;
  const month = MONTHS[m[2]];
  if (month === undefined) return null;
  const local = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]));
  const offsetMs = (Number(m[6]) * 60 + Number(m[7])) * 60 * 1000 * (m[5] === '-' ? -1 : 1);
  const utc = local - offsetMs;
  return new Date(Math.floor(utc / HOUR_MS) * HOUR_MS);
}

export interface TrafficHourRow {
  projectId: string;
  hour: Date;
  requests: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  bytesSent: number;
  /** Counts per TRAFFIC_LATENCY_BUCKETS_MS slot (+ overflow); empty when unknown. */
  latencyBuckets: number[];
}

/** Element-wise sum; a shorter (or empty) histogram counts as zeros. */
export function addLatencyBuckets(a: readonly number[], b: readonly number[]): number[] {
  const len = Math.max(a.length, b.length);
  const out: number[] = [];
  for (let i = 0; i < len; i++) out.push((Number(a[i]) || 0) + (Number(b[i]) || 0));
  return out;
}

function parseHistogram(value: string): number[] | null {
  const parts = value.split(',');
  if (parts.length !== BUCKET_COUNT) return null;
  const nums = parts.map((p) => (/^\d+$/.test(p) ? Number(p) : NaN));
  return nums.some((n) => !Number.isFinite(n)) ? null : nums;
}

/** Parse phase-1 output; rows for the same project and hour (several files) are summed. */
export function parseTrafficCollectOutput(stdout: string): { rows: TrafficHourRow[]; files: string[] } {
  const files: string[] = [];
  const merged = new Map<string, TrafficHourRow>();
  for (const raw of stdout.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#FILE ')) {
      const name = line.slice(6).trim();
      if (COLLECT_FILE_RE.test(name)) files.push(name);
      continue;
    }
    const parts = raw.replace(/\r$/, '').split('\t');
    if (parts.length !== 9) continue;
    const [projectId, key, ...rest] = parts;
    if (!UUID_RE.test(projectId)) continue;
    const hour = parseLogHour(key);
    const nums = rest.slice(0, 6).map((n) => Number(n));
    const latencyBuckets = parseHistogram(rest[6]);
    if (!hour || !latencyBuckets || nums.some((n) => !Number.isFinite(n) || n < 0)) continue;
    const [requests, status2xx, status3xx, status4xx, status5xx, bytesSent] = nums;
    const id = `${projectId}|${hour.toISOString()}`;
    const prev = merged.get(id);
    if (prev) {
      prev.requests += requests;
      prev.status2xx += status2xx;
      prev.status3xx += status3xx;
      prev.status4xx += status4xx;
      prev.status5xx += status5xx;
      prev.bytesSent += bytesSent;
      prev.latencyBuckets = addLatencyBuckets(prev.latencyBuckets, latencyBuckets);
    } else {
      merged.set(id, {
        projectId,
        hour,
        requests,
        status2xx,
        status3xx,
        status4xx,
        status5xx,
        bytesSent,
        latencyBuckets,
      });
    }
  }
  return { rows: [...merged.values()], files };
}

/**
 * Estimate a percentile (0–1) in ms from a histogram, interpolating linearly inside the bucket
 * it falls in. null when the histogram is empty. In the overflow bucket the last bound is
 * returned (i.e. "at least this slow").
 */
export function latencyPercentileMs(buckets: readonly number[], q: number): number | null {
  const counts = buckets.map((c) => Number(c) || 0);
  const total = counts.reduce((s, c) => s + c, 0);
  if (total <= 0) return null;
  const bounds = TRAFFIC_LATENCY_BUCKETS_MS;
  const rank = q * total;
  let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (c > 0 && cum + c >= rank) {
      if (i >= bounds.length) return bounds[bounds.length - 1];
      const lower = i === 0 ? 0 : bounds[i - 1];
      return Math.round(lower + (bounds[i] - lower) * ((rank - cum) / c));
    }
    cum += c;
  }
  return bounds[bounds.length - 1];
}

export interface TrafficPoint {
  hour: string;
  requests: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  bytesSent: number;
  /** null when no request time was recorded in this hour */
  p95LatencyMs: number | null;
}

export interface TrafficAnalytics {
  enabled: boolean;
  range: TrafficRange;
  bucket: 'hour';
  retentionDays: number;
  totals: {
    requests: number;
    status2xx: number;
    status3xx: number;
    status4xx: number;
    status5xx: number;
    /** 0–1 */
    errorRate4xx: number;
    errorRate5xx: number;
    bytesSent: number;
    /** p95 of request time over the whole range; null when no request time was recorded */
    p95LatencyMs: number | null;
  };
  series: TrafficPoint[];
}

type StoredHourRow = Omit<TrafficHourRow, 'projectId'>;

/** One point per hour of the range (oldest first, empty hours as zeros) plus the totals. */
export function buildTrafficAnalytics(
  rows: StoredHourRow[],
  range: TrafficRange,
  enabled: boolean,
  now: Date = new Date()
): TrafficAnalytics {
  const hours = TRAFFIC_RANGES[range];
  const current = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS;
  const start = current - (hours - 1) * HOUR_MS;
  const byHour = new Map<number, StoredHourRow>();
  for (const r of rows) byHour.set(r.hour.getTime(), r);

  const series: TrafficPoint[] = [];
  const totals = { requests: 0, status2xx: 0, status3xx: 0, status4xx: 0, status5xx: 0, bytesSent: 0 };
  let histogram: number[] = [];
  for (let t = start; t <= current; t += HOUR_MS) {
    const r = byHour.get(t);
    const buckets = r?.latencyBuckets ?? [];
    const point: TrafficPoint = {
      hour: new Date(t).toISOString(),
      requests: r?.requests ?? 0,
      status2xx: r?.status2xx ?? 0,
      status3xx: r?.status3xx ?? 0,
      status4xx: r?.status4xx ?? 0,
      status5xx: r?.status5xx ?? 0,
      bytesSent: r?.bytesSent ?? 0,
      p95LatencyMs: latencyPercentileMs(buckets, 0.95),
    };
    totals.requests += point.requests;
    totals.status2xx += point.status2xx;
    totals.status3xx += point.status3xx;
    totals.status4xx += point.status4xx;
    totals.status5xx += point.status5xx;
    totals.bytesSent += point.bytesSent;
    histogram = addLatencyBuckets(histogram, buckets);
    series.push(point);
  }

  const rate = (n: number) => (totals.requests > 0 ? n / totals.requests : 0);
  return {
    enabled,
    range,
    bucket: 'hour',
    retentionDays: TRAFFIC_RETENTION_DAYS,
    totals: {
      ...totals,
      errorRate4xx: rate(totals.status4xx),
      errorRate5xx: rate(totals.status5xx),
      p95LatencyMs: latencyPercentileMs(histogram, 0.95),
    },
    series,
  };
}
