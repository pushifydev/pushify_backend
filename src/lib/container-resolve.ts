import { eq } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { decrypt } from './encryption';
import { logger } from './logger';
import { execCommand } from '../workers/shell';
import { isContainerRunning } from '../workers/docker';
import { isContainerRunning as isRemoteContainerRunning } from '../workers/remote-docker';
import { SSHClient } from '../utils/ssh';

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

/**
 * Restart the active Pushify container for a project (local or remote via SSH).
 */
export async function restartPushifyContainer(
  slug: string,
  serverId: string | null
): Promise<boolean> {
  let ssh: SSHClient | null = null;
  try {
    if (serverId) {
      const server = await db.query.servers.findFirst({
        where: eq(servers.id, serverId),
      });
      if (!server?.ipv4 || !server.sshPrivateKey) {
        return false;
      }
      ssh = new SSHClient();
      await ssh.connect({
        host: server.ipv4,
        port: 22,
        username: 'root',
        privateKey: decrypt(server.sshPrivateKey),
      });
    }

    const containerName = await resolvePushifyContainerName(slug, ssh);
    if (!containerName) {
      logger.warn({ slug, serverId }, 'No running container found to restart');
      return false;
    }

    if (ssh) {
      const result = await ssh.exec(`docker restart ${containerName}`);
      if (result.code === 0) {
        logger.info({ slug, serverId, containerName }, 'Container restarted via SSH');
        return true;
      }
      return false;
    }

    const { exitCode } = await execCommand(`docker restart ${containerName}`, {
      timeout: 30000,
    });
    if (exitCode === 0) {
      logger.info({ slug, containerName }, 'Container restarted locally');
      return true;
    }
    return false;
  } catch (error) {
    logger.error({ err: error, slug, serverId }, 'Failed to restart container');
    return false;
  } finally {
    ssh?.disconnect();
  }
}
