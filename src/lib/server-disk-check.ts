import type { SSHClient } from '../utils/ssh';
import { env } from '../config/env';

export interface ServerDiskCheckResult {
  ok: boolean;
  usedPercent: number;
  availGb: number;
  mount: string;
  warn: boolean;
  critical: boolean;
  message: string;
  /** False when `df` printed nothing usable — the numbers above are then placeholders */
  measured: boolean;
}

const WARN_PERCENT = env.SERVER_DISK_WARN_PERCENT;
const CRITICAL_PERCENT = env.SERVER_DISK_CRITICAL_PERCENT;

/**
 * Check root filesystem usage on the deployment host (SSH).
 */
export async function checkServerDiskSpace(ssh: SSHClient): Promise<ServerDiskCheckResult> {
  const result = await ssh.exec(
    `df -P / 2>/dev/null | tail -1 | awk '{print $5,$4,$6}' | tr -d '%'`
  );

  const parts = result.stdout.trim().split(/\s+/);
  const measured = /^\d+$/.test(parts[0] ?? '') && /^\d+$/.test(parts[1] ?? '');
  const usedPercent = parseInt(parts[0] || '0', 10) || 0;
  const availKb = parseInt(parts[1] || '0', 10) || 0;
  const mount = parts[2] || '/';
  const availGb = Math.round((availKb / 1024 / 1024) * 10) / 10;

  const critical = usedPercent >= CRITICAL_PERCENT;
  const warn = usedPercent >= WARN_PERCENT;

  let message: string;
  if (critical) {
    message = `⚠️ Disk critical: ${usedPercent}% used on ${mount} (${availGb} GB free). Deploy may fail — see the server's health page for what holds the space, or resize the server.`;
  } else if (warn) {
    message = `⚠️ Disk warning: ${usedPercent}% used on ${mount} (${availGb} GB free). Consider cleaning old images.`;
  } else {
    message = `💾 Disk OK: ${usedPercent}% used (${availGb} GB free on ${mount})`;
  }

  return {
    ok: !critical,
    usedPercent,
    availGb,
    mount,
    warn,
    critical,
    message,
    measured,
  };
}

/**
 * The disk alert: one message when the root disk crosses the server's threshold, none while it
 * stays up there, and the next one only after it has come back down by this many points and
 * crossed again. No reminders — a disk hovering at the line must not mail every hour.
 */
export const DISK_ALERT_CLEAR_MARGIN = 5;
/** Lowest threshold a user can set; under it the alert is noise on any real server. */
export const DISK_ALERT_MIN_PERCENT = 50;

/** Highest threshold a user can set: the alert has to come before deploys are refused. */
export function diskAlertMaxPercent(): number {
  return env.SERVER_DISK_DEPLOY_BLOCK_PERCENT - 1;
}

export function isValidDiskAlertPercent(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= DISK_ALERT_MIN_PERCENT &&
    value <= diskAlertMaxPercent()
  );
}

/** The threshold in force for a server: its own, or the install default. */
export function diskAlertPercentFor(server: { diskAlertPercent: number | null }): number {
  return server.diskAlertPercent ?? WARN_PERCENT;
}

/**
 * Where one hourly reading leaves the alert state. `notifiedAt` set means "already told about
 * this crossing". A reading that could not be measured changes nothing.
 */
export function nextDiskAlertState(
  notifiedAt: Date | null,
  disk: Pick<ServerDiskCheckResult, 'usedPercent' | 'measured'>,
  thresholdPercent: number,
  now: Date
): { notify: boolean; notifiedAt: Date | null } {
  if (!disk.measured) return { notify: false, notifiedAt };
  if (disk.usedPercent >= thresholdPercent) {
    return notifiedAt ? { notify: false, notifiedAt } : { notify: true, notifiedAt: now };
  }
  if (notifiedAt && disk.usedPercent <= thresholdPercent - DISK_ALERT_CLEAR_MARGIN) {
    return { notify: false, notifiedAt: null };
  }
  return { notify: false, notifiedAt };
}

/** Prefix of the server status message written when a deploy is refused for disk space. */
export const DISK_FULL_STATUS_PREFIX = 'Disk full:';

export interface DeployDiskThresholds {
  blockPercent: number;
  minFreeGb: number;
}

const DEFAULT_DEPLOY_THRESHOLDS: DeployDiskThresholds = {
  blockPercent: env.SERVER_DISK_DEPLOY_BLOCK_PERCENT,
  minFreeGb: env.SERVER_DISK_DEPLOY_MIN_FREE_GB,
};

/**
 * Should a deploy / container start be refused because the host is (nearly) out of disk?
 * Returns the user-facing reason, or null when there is enough room. A reading that could not
 * be parsed never blocks: an odd `df` must not stop every deploy. `cleanupNote` says what the
 * automatic cleanup already did (deploy-disk-cleanup.ts).
 *
 * No `docker system prune` advice: with `-a` it deletes the rollback images, and `--volumes`
 * deletes customer data.
 */
export function deployDiskBlockReason(
  disk: Pick<ServerDiskCheckResult, 'usedPercent' | 'availGb' | 'mount' | 'measured'>,
  thresholds: DeployDiskThresholds = DEFAULT_DEPLOY_THRESHOLDS,
  cleanupNote?: string
): string | null {
  if (!disk.measured) return null;
  const tooFull = disk.usedPercent >= thresholds.blockPercent;
  const tooLittleFree = disk.availGb < thresholds.minFreeGb;
  if (!tooFull && !tooLittleFree) return null;
  return (
    `${DISK_FULL_STATUS_PREFIX} ${disk.usedPercent}% used, ${disk.availGb} GB free on ${disk.mount} ` +
    `(deploys need < ${thresholds.blockPercent}% used and at least ${thresholds.minFreeGb} GB free). ` +
    (cleanupNote ? `${cleanupNote} ` : '') +
    `See the server's health page for what holds the space, or resize the server, then deploy again.`
  );
}
