import { execCommand } from '../workers/shell';
import { isContainerRunning } from '../workers/docker';
import { isContainerRunning as isRemoteContainerRunning } from '../workers/remote-docker';
import type { SSHClient } from '../utils/ssh';

/** Sidecar / data containers we should not use for app-level metrics */
const SIDECAR_NAME_PATTERN = /-(db|redis|postgres|mysql|kong|mail)(-\d+)?$/i;

/**
 * Resolve the running container name for a Pushify project slug.
 * Matches log-collector behavior (blue/green) and compose stacks (pushify-{slug}-*).
 */
export async function resolvePushifyContainerName(
  slug: string,
  ssh: SSHClient | null
): Promise<string | null> {
  const base = `pushify-${slug}`;

  for (const suffix of ['-blue', '-green', ''] as const) {
    const name = `${base}${suffix}`;
    const running = ssh
      ? await isRemoteContainerRunning(ssh, name)
      : await isContainerRunning(name);
    if (running) return name;
  }

  const listCmd = `docker ps --format '{{.Names}}' | grep -E '^${base}(-|$)' || true`;
  let names: string[] = [];
  if (ssh) {
    const r = await ssh.exec(listCmd);
    names = r.stdout.trim().split('\n').filter(Boolean);
  } else {
    const { stdout } = await execCommand(listCmd, { timeout: 5000 });
    names = stdout.trim().split('\n').filter(Boolean);
  }

  if (names.length === 0) return null;

  const appContainers = names.filter(
    (n) => !SIDECAR_NAME_PATTERN.test(n) && !n.includes('-db-')
  );
  return appContainers[0] ?? names[0];
}

/** Docker stats JSON may prefix container names with "/" */
export function normalizeDockerStatsName(name: string): string {
  return name.replace(/^\//, '');
}
