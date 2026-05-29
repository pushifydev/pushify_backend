import type { SSHClient } from '../utils/ssh';
import { execCommand } from '../workers/shell';
import { logger } from './logger';

const DOCKER_DF_TYPES = new Set(['Images', 'Containers', 'Local Volumes']);

function parseDockerSizeToBytes(raw: string): number {
  const trimmed = raw.trim();
  const match = trimmed.match(/^([\d.]+)\s*([a-zA-Z]+)?$/);
  if (!match) return 0;

  const value = parseFloat(match[1]);
  if (!Number.isFinite(value)) return 0;

  const unit = (match[2] || 'B').toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1000,
    KIB: 1024,
    MB: 1000 * 1000,
    MIB: 1024 * 1024,
    GB: 1000 * 1000 * 1000,
    GIB: 1024 * 1024 * 1024,
    TB: 1000 * 1000 * 1000 * 1000,
    TIB: 1024 * 1024 * 1024 * 1024,
  };

  return Math.round(value * (multipliers[unit] ?? 1));
}

function sumDockerDfOutput(stdout: string): number {
  let total = 0;
  for (const line of stdout.trim().split('\n')) {
    const [type, size] = line.split('\t');
    if (!type || !size || !DOCKER_DF_TYPES.has(type.trim())) continue;
    total += parseDockerSizeToBytes(size);
  }
  return total;
}

export async function getDockerSystemDiskBytes(ssh: SSHClient | null): Promise<number> {
  const cmd = `docker system df --format '{{.Type}}\t{{.Size}}'`;
  try {
    if (ssh) {
      const result = await ssh.exec(cmd);
      if (result.code !== 0 || !result.stdout?.trim()) return 0;
      return sumDockerDfOutput(result.stdout);
    }

    const result = await execCommand(cmd);
    if (result.exitCode !== 0 || !result.stdout?.trim()) return 0;
    return sumDockerDfOutput(result.stdout);
  } catch (error) {
    logger.warn({ err: error }, 'docker system df failed');
    return 0;
  }
}
