import type { SSHClient } from '../utils/ssh';

/**
 * Scheduled disk cleanup for managed servers.
 *
 * The hourly disk check only ever *reported* a filling disk. Per-container log caps
 * (`APP_CONTAINER_HARDENING`) cover `docker run` containers, but marketplace compose stacks
 * (Supabase, …) are started by `docker compose` and got Docker's default: an unbounded
 * json-file log. Nothing ever trimmed dangling images or old build cache either.
 *
 * This cleanup only touches what Pushify can always rebuild or does not need:
 *   - container json logs above a size cap (log history is collected to the database anyway),
 *   - dangling (untagged) images — tagged rollback images are kept,
 *   - build cache older than a few days.
 * It never removes containers (a sleeping app is a stopped container) or volumes (customer data).
 */

/** Daemon-wide default so every container — compose stacks included — gets a capped log. */
export const DOCKER_DAEMON_LOG_CONFIG = {
  'log-driver': 'json-file',
  'log-opts': { 'max-size': '10m', 'max-file': '3' },
} as const;

export const DOCKER_DAEMON_JSON = JSON.stringify(DOCKER_DAEMON_LOG_CONFIG, null, 2);

/** Container json logs larger than this are truncated in place. */
export const LOG_TRUNCATE_THRESHOLD_MB = 100;

/** Build cache unused for longer than this is pruned. */
export const BUILD_CACHE_MAX_AGE = '72h';

/**
 * A container without a log cap has its json log rotated (truncated) above this size: what the
 * daemon default would keep at most (max-size 10m × max-file 3).
 */
export const UNCAPPED_LOG_ROTATE_MB = 30;

export const CLEANUP_MARKER = 'PUSHIFY_CLEANUP';

/**
 * Shell run over SSH. Prints one machine-readable line at the end:
 *   PUSHIFY_CLEANUP before=<bytes> after=<bytes> logs=<bytes> daemon=<created|present|skipped>
 *     volumes=<docker size> images=<docker size> buildcache=<docker size> containers=<docker size>
 *     logfiles=<bytes> uncapped=<count> rotated=<count> total=<bytes>
 *
 * `daemon.json` log-opts only apply to containers created after the daemon (re)loads it, so
 * containers that already exist — typically compose stacks such as Supabase — keep an unbounded
 * json-file log. Those are found with `docker inspect` (json-file driver, no `max-size`) and their
 * log is rotated in place once it exceeds what the cap would allow (max-size × max-file). They
 * are not recreated: that would restart customer services. They pick up the cap the next time
 * they are recreated after the daemon has reloaded its config.
 *
 * `/etc/docker/daemon.json` is only written when it does not exist (a hand-tuned file is never
 * overwritten) and Docker is NOT restarted: restarting would stop every container on the host.
 * The default applies to containers created after the next daemon restart / reboot; until then
 * the log truncation keeps existing containers bounded.
 */
export function buildDiskCleanupScript(): string {
  return [
    'used() { df -P -B1 / 2>/dev/null | tail -1 | awk \'{print $3}\'; }',
    'BEFORE=$(used)',
    'DAEMON=present',
    'if [ ! -e /etc/docker/daemon.json ]; then',
    '  if mkdir -p /etc/docker && cat > /etc/docker/daemon.json <<\'PUSHIFY_DAEMON_JSON\'',
    DOCKER_DAEMON_JSON,
    'PUSHIFY_DAEMON_JSON',
    '  then DAEMON=created; else DAEMON=skipped; fi',
    'fi',
    'LOGS=0',
    'UNCAPPED=0',
    'ROTATED=0',
    // Containers created before the daemon default took effect: json-file without max-size.
    'for id in $(docker ps -aq --no-trunc 2>/dev/null); do',
    '  cfg=$(docker inspect --format \'{{.HostConfig.LogConfig.Type}} {{index .HostConfig.LogConfig.Config "max-size"}}\' "$id" 2>/dev/null) || continue',
    '  drv=${cfg%% *}; cap=${cfg#* }; [ "$cap" = "$cfg" ] && cap=""',
    '  if [ "$drv" = json-file ] && [ -z "$cap" ]; then',
    '    UNCAPPED=$((UNCAPPED + 1))',
    '    f=/var/lib/docker/containers/$id/$id-json.log',
    '    s=$(stat -c %s "$f" 2>/dev/null || echo 0)',
    `    if [ "$s" -gt $((${UNCAPPED_LOG_ROTATE_MB} * 1024 * 1024)) ] && truncate -s 0 "$f"; then`,
    '      LOGS=$((LOGS + s)); ROTATED=$((ROTATED + 1))',
    '    fi',
    '  fi',
    'done',
    'if [ -d /var/lib/docker/containers ]; then',
    `  for f in $(find /var/lib/docker/containers -name '*-json.log' -size +${LOG_TRUNCATE_THRESHOLD_MB}M 2>/dev/null); do`,
    '    s=$(stat -c %s "$f" 2>/dev/null || echo 0)',
    '    truncate -s 0 "$f" && LOGS=$((LOGS + s))',
    '  done',
    'fi',
    'docker image prune -f >/dev/null 2>&1 || true',
    `docker builder prune -af --filter until=${BUILD_CACHE_MAX_AGE} >/dev/null 2>&1 || true`,
    'AFTER=$(used)',
    "TOTAL=$(df -P -B1 / 2>/dev/null | tail -1 | awk '{print $2}')",
    // Where the remaining space sits: docker's own accounting plus the container log files.
    "DF=$(docker system df --format '{{.Type}}\\t{{.Size}}' 2>/dev/null)",
    "dfsize() { printf '%s\\n' \"$DF\" | awk -F'\\t' -v t=\"$1\" '$1==t {print $2}' | tr -d ' '; }",
    'VOL=$(dfsize "Local Volumes"); IMG=$(dfsize Images); BC=$(dfsize "Build Cache"); CTR=$(dfsize Containers)',
    "LOGFILES=$(find /var/lib/docker/containers -name '*-json.log*' -printf '%s\\n' 2>/dev/null | awk '{s+=$1} END {print s+0}')",
    `echo "${CLEANUP_MARKER} before=\${BEFORE:-0} after=\${AFTER:-0} logs=\${LOGS:-0} daemon=\${DAEMON} volumes=\${VOL:-0B}` +
      ` images=\${IMG:-0B} buildcache=\${BC:-0B} containers=\${CTR:-0B} logfiles=\${LOGFILES:-0}` +
      ` uncapped=\${UNCAPPED:-0} rotated=\${ROTATED:-0} total=\${TOTAL:-0}"`,
  ].join('\n');
}

export interface DiskCleanupResult {
  /** False when the script's summary line was missing — numbers below are then zero */
  ran: boolean;
  freedBytes: number;
  logsTruncatedBytes: number;
  daemonConfig: 'created' | 'present' | 'skipped' | 'unknown';
  /** Space held by Docker volumes (customer data) — reported, never removed */
  volumesBytes: number;
  imagesBytes: number;
  buildCacheBytes: number;
  /** Writable layers of containers */
  containersBytes: number;
  /** Container json log files on disk after the cleanup */
  logsBytes: number;
  /** Containers whose json-file log has no max-size (created before the daemon default) */
  uncappedLogContainers: number;
  /** Of those, how many had their log rotated in this run */
  rotatedLogContainers: number;
  usedBytes: number;
  totalBytes: number;
}

/** What holds the space on a server, written to `servers.disk_breakdown` after each cleanup. */
export interface ServerDiskBreakdown {
  measuredAt: string;
  usedBytes: number;
  totalBytes: number;
  imagesBytes: number;
  buildCacheBytes: number;
  containersBytes: number;
  logsBytes: number;
  volumesBytes: number;
  /** Largest consumer; `other` when Docker accounts for less than half of the used space */
  heldBy: 'images' | 'build_cache' | 'containers' | 'logs' | 'volumes' | 'other';
  /** True when volumes (customer data) are the largest consumer: outside what cleanup may touch */
  userData: boolean;
  uncappedLogContainers: number;
  cleanup: { freedBytes: number; logsTruncatedBytes: number; rotatedLogContainers: number; daemonConfig: DiskCleanupResult['daemonConfig'] };
}

export function buildDiskBreakdown(r: DiskCleanupResult, now: Date = new Date()): ServerDiskBreakdown {
  const parts = {
    images: r.imagesBytes,
    build_cache: r.buildCacheBytes,
    containers: r.containersBytes,
    logs: r.logsBytes,
    volumes: r.volumesBytes,
  } as const;
  const docker = Object.values(parts).reduce((a, b) => a + b, 0);
  let heldBy: ServerDiskBreakdown['heldBy'] = 'other';
  if (docker > 0 && (r.usedBytes === 0 || docker * 2 >= r.usedBytes)) {
    heldBy = (Object.keys(parts) as Array<keyof typeof parts>).reduce((a, b) => (parts[b] > parts[a] ? b : a));
  }
  return {
    measuredAt: now.toISOString(),
    usedBytes: r.usedBytes,
    totalBytes: r.totalBytes,
    imagesBytes: r.imagesBytes,
    buildCacheBytes: r.buildCacheBytes,
    containersBytes: r.containersBytes,
    logsBytes: r.logsBytes,
    volumesBytes: r.volumesBytes,
    heldBy,
    userData: heldBy === 'volumes',
    uncappedLogContainers: r.uncappedLogContainers,
    cleanup: {
      freedBytes: r.freedBytes,
      logsTruncatedBytes: r.logsTruncatedBytes,
      rotatedLogContainers: r.rotatedLogContainers,
      daemonConfig: r.daemonConfig,
    },
  };
}

const NOT_RAN: DiskCleanupResult = {
  ran: false,
  freedBytes: 0,
  logsTruncatedBytes: 0,
  daemonConfig: 'unknown',
  volumesBytes: 0,
  imagesBytes: 0,
  buildCacheBytes: 0,
  containersBytes: 0,
  logsBytes: 0,
  uncappedLogContainers: 0,
  rotatedLogContainers: 0,
  usedBytes: 0,
  totalBytes: 0,
};

export function parseDockerSizeToBytes(raw: string): number {
  const match = raw.trim().match(/^([\d.]+)\s*([a-zA-Z]+)?$/);
  if (!match) return 0;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = (match[2] || 'B').toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1e3,
    KIB: 1024,
    MB: 1e6,
    MIB: 1024 ** 2,
    GB: 1e9,
    GIB: 1024 ** 3,
    TB: 1e12,
    TIB: 1024 ** 4,
  };
  return Math.round(value * (multipliers[unit] ?? 1));
}

export function parseDiskCleanupOutput(stdout: string): DiskCleanupResult {
  const line = stdout.split('\n').find((l) => l.startsWith(CLEANUP_MARKER));
  if (!line) return { ...NOT_RAN };
  const fields: Record<string, string> = {};
  for (const part of line.slice(CLEANUP_MARKER.length).trim().split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) fields[part.slice(0, eq)] = part.slice(eq + 1);
  }
  const num = (v: string | undefined) => {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const daemon = fields.daemon;
  return {
    ran: true,
    freedBytes: Math.max(0, num(fields.before) - num(fields.after)),
    logsTruncatedBytes: num(fields.logs),
    daemonConfig: daemon === 'created' || daemon === 'present' || daemon === 'skipped' ? daemon : 'unknown',
    volumesBytes: parseDockerSizeToBytes(fields.volumes ?? ''),
    imagesBytes: parseDockerSizeToBytes(fields.images ?? ''),
    buildCacheBytes: parseDockerSizeToBytes(fields.buildcache ?? ''),
    containersBytes: parseDockerSizeToBytes(fields.containers ?? ''),
    logsBytes: num(fields.logfiles),
    uncappedLogContainers: num(fields.uncapped),
    rotatedLogContainers: num(fields.rotated),
    usedBytes: num(fields.after),
    totalBytes: num(fields.total),
  };
}

/** Run the cleanup on a server. Never throws: a failed cleanup must not stop the disk check. */
export async function runServerDiskCleanup(ssh: SSHClient): Promise<DiskCleanupResult> {
  try {
    const result = await ssh.exec(buildDiskCleanupScript());
    return parseDiskCleanupOutput(result.stdout ?? '');
  } catch {
    return { ...NOT_RAN };
  }
}
