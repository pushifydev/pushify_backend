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

/** Run a command either over SSH (remote host) or locally (when ssh is null). */
async function runDockerCommand(
  ssh: SSHClient | null,
  cmd: string,
): Promise<{ ok: boolean; stdout: string }> {
  if (ssh) {
    const result = await ssh.exec(cmd);
    return { ok: result.code === 0, stdout: result.stdout ?? '' };
  }
  const result = await execCommand(cmd);
  return { ok: result.exitCode === 0, stdout: result.stdout ?? '' };
}

/**
 * Measure the on-disk footprint of an organization's OWN Docker images (in bytes),
 * instead of the whole-host docker disk. This keeps multi-tenant hosts fair: each org
 * is only charged for the images built from its own projects.
 *
 * `repoPrefixes` are the project image repositories (e.g. `pushify/<slug>`). A row matches
 * when its Repository equals a prefix exactly OR startsWith the prefix — the latter also
 * captures preview-deploy images such as `pushify/<slug><deploySuffix>`.
 *
 * Image IDs are de-duplicated so a multi-tagged image is counted once, then each unique
 * image's real size is read via `docker image inspect -f '{{.Size}}'` (raw bytes) and summed.
 * Returns 0 on empty match or any error (metering must never block deploys).
 */
export async function getImagesFootprintBytes(
  ssh: SSHClient | null,
  repoPrefixes: string[],
): Promise<number> {
  if (repoPrefixes.length === 0) return 0;

  try {
    // List every image's ID + Repository so we can select this org's images by repo prefix.
    const listCmd = `docker images --no-trunc --format '{{.ID}}\t{{.Repository}}'`;
    const listed = await runDockerCommand(ssh, listCmd);
    if (!listed.ok || !listed.stdout.trim()) return 0;

    const uniqueIds = new Set<string>();
    for (const line of listed.stdout.trim().split('\n')) {
      const [id, repository] = line.split('\t');
      if (!id || !repository) continue;
      const repo = repository.trim();
      const matches = repoPrefixes.some(
        (prefix) => repo === prefix || repo.startsWith(prefix),
      );
      if (matches) uniqueIds.add(id.trim());
    }

    if (uniqueIds.size === 0) return 0;

    // Inspect the unique image IDs and sum their raw byte sizes.
    const ids = [...uniqueIds].join(' ');
    const inspectCmd = `docker image inspect -f '{{.Size}}' ${ids}`;
    const inspected = await runDockerCommand(ssh, inspectCmd);
    if (!inspected.ok || !inspected.stdout.trim()) return 0;

    let total = 0;
    for (const line of inspected.stdout.trim().split('\n')) {
      const size = parseInt(line.trim(), 10);
      if (Number.isFinite(size) && size > 0) total += size;
    }
    return total;
  } catch (error) {
    logger.warn({ err: error }, 'docker images footprint measurement failed');
    return 0;
  }
}
