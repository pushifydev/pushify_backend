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

export const CLEANUP_MARKER = 'PUSHIFY_CLEANUP';

/**
 * Shell run over SSH. Prints one machine-readable line at the end:
 *   PUSHIFY_CLEANUP before=<bytes> after=<bytes> logs=<bytes> daemon=<created|present|skipped> volumes=<docker size>
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
    'if [ -d /var/lib/docker/containers ]; then',
    `  for f in $(find /var/lib/docker/containers -name '*-json.log' -size +${LOG_TRUNCATE_THRESHOLD_MB}M 2>/dev/null); do`,
    '    s=$(stat -c %s "$f" 2>/dev/null || echo 0)',
    '    truncate -s 0 "$f" && LOGS=$((LOGS + s))',
    '  done',
    'fi',
    'docker image prune -f >/dev/null 2>&1 || true',
    `docker builder prune -af --filter until=${BUILD_CACHE_MAX_AGE} >/dev/null 2>&1 || true`,
    'AFTER=$(used)',
    "VOL=$(docker system df --format '{{.Type}}\\t{{.Size}}' 2>/dev/null | awk -F'\\t' '$1==\"Local Volumes\" {print $2}' | tr -d ' ')",
    `echo "${CLEANUP_MARKER} before=\${BEFORE:-0} after=\${AFTER:-0} logs=\${LOGS:-0} daemon=\${DAEMON} volumes=\${VOL:-0B}"`,
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
}

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
  if (!line) {
    return { ran: false, freedBytes: 0, logsTruncatedBytes: 0, daemonConfig: 'unknown', volumesBytes: 0 };
  }
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
  };
}

/** Run the cleanup on a server. Never throws: a failed cleanup must not stop the disk check. */
export async function runServerDiskCleanup(ssh: SSHClient): Promise<DiskCleanupResult> {
  try {
    const result = await ssh.exec(buildDiskCleanupScript());
    return parseDiskCleanupOutput(result.stdout ?? '');
  } catch {
    return { ran: false, freedBytes: 0, logsTruncatedBytes: 0, daemonConfig: 'unknown', volumesBytes: 0 };
  }
}
