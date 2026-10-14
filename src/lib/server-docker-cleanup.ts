import type { SSHClient } from '../utils/ssh';
import { checkServerDiskSpace } from './server-disk-check';

/**
 * Automatic Docker cleanup for a managed server whose disk is filling up.
 *
 * Deliberately conservative — every step leaves running apps, sleeping apps and rollbacks intact:
 *  - Containers: only `dead` ones (Docker could not stop/remove them; they can never start again).
 *    Exited containers are NOT pruned: app-sleep and database stop leave containers stopped on
 *    purpose and start them again later, so removing them would break wake-up/start.
 *  - Images: dangling only (`<none>` layers left behind when `latest`/a tag moves to a new build).
 *    Never `-a`: every tagged image survives, including the `pushify-<slug>:deploy-<id>` tags quick
 *    rollback relies on, and Docker never removes an image a container (running or stopped) uses.
 *  - Build cache: entries unused for BUILD_CACHE_KEEP_HOURS. Running containers never depend on
 *    it; the next build of a recent project still hits its cache.
 * Volumes are never touched — that is customer data.
 */
export const BUILD_CACHE_KEEP_HOURS = 72;

export const DOCKER_CLEANUP_COMMANDS: readonly string[] = [
  `docker ps -aq --filter status=dead | xargs -r docker rm -f 2>/dev/null || true`,
  'docker image prune -f 2>/dev/null || true',
  `docker builder prune -f --filter until=${BUILD_CACHE_KEEP_HOURS}h 2>/dev/null || true`,
];

export interface DockerCleanupResult {
  beforePercent: number;
  afterPercent: number;
  logs: string;
}

/** Run the cleanup and measure the root filesystem before and after. */
export async function runDockerCleanup(ssh: SSHClient): Promise<DockerCleanupResult> {
  const before = await checkServerDiskSpace(ssh);
  let logs = '';
  for (const cmd of DOCKER_CLEANUP_COMMANDS) {
    const result = await ssh.exec(cmd);
    logs += `${result.stdout}${result.stderr}`;
  }
  const after = await checkServerDiskSpace(ssh);
  return { beforePercent: before.usedPercent, afterPercent: after.usedPercent, logs: logs.trim() };
}
