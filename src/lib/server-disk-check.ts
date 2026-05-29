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
  };
}
