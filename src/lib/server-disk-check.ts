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
    message = `⚠️ Disk critical: ${usedPercent}% used on ${mount} (${availGb} GB free). Deploy may fail — run docker system prune on the server.`;
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
 * be parsed never blocks: an odd `df` must not stop every deploy.
 */
export function deployDiskBlockReason(
  disk: Pick<ServerDiskCheckResult, 'usedPercent' | 'availGb' | 'mount' | 'measured'>,
  thresholds: DeployDiskThresholds = DEFAULT_DEPLOY_THRESHOLDS
): string | null {
  if (!disk.measured) return null;
  const tooFull = disk.usedPercent >= thresholds.blockPercent;
  const tooLittleFree = disk.availGb < thresholds.minFreeGb;
  if (!tooFull && !tooLittleFree) return null;
  return (
    `${DISK_FULL_STATUS_PREFIX} ${disk.usedPercent}% used, ${disk.availGb} GB free on ${disk.mount} ` +
    `(deploys need < ${thresholds.blockPercent}% used and at least ${thresholds.minFreeGb} GB free). ` +
    `Free space on the server (e.g. docker system prune) or resize it, then deploy again.`
  );
}
