import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import type { projects } from '../db/schema/projects';
import { decrypt } from './encryption';
import { logger } from './logger';
import { SSHClient } from '../utils/ssh';
import { releasePort } from '../workers/port-manager';

type ProjectRow = typeof projects.$inferSelect;

function shellEscapeSlug(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`Invalid project slug for cleanup: ${slug}`);
  }
  return slug;
}

/** Build remote shell script that stops every Pushify container for this slug. */
export function buildRemoteTeardownScript(slug: string, isCompose: boolean): string {
  const safeSlug = shellEscapeSlug(slug);
  const base = `pushify-${safeSlug}`;
  const projectDir = `/opt/pushify/apps/${safeSlug}`;

  const stopAllMatching = [
    `ids=$(docker ps -aq --format '{{.Names}}' | grep -E '^${base}(-|$)|^pushify-preview-${safeSlug}' || true)`,
    'if [ -n "$ids" ]; then docker rm -f $ids 2>/dev/null || true; fi',
    `docker rm -f ${base} ${base}-blue ${base}-green ${base}-db 2>/dev/null || true`,
    `docker rm -f $(docker ps -aq --filter "name=pushify-preview-${safeSlug}" 2>/dev/null) 2>/dev/null || true`,
    `docker network rm ${base}-net pushify-${safeSlug}-net 2>/dev/null || true`,
  ].join('; ');

  const composeDown = isCompose
    ? [
        `cd ${projectDir} 2>/dev/null && docker compose -p ${base} down -v 2>/dev/null || true`,
        `docker rm -f $(docker ps -aq --filter "name=${base}-" 2>/dev/null) 2>/dev/null || true`,
      ].join('; ')
    : '';

  const filesystemAndNginx = [
    `rm -rf ${projectDir}`,
    `rm -f /etc/nginx/conf.d/${safeSlug}.pushify.dev.conf /etc/nginx/sites-enabled/${safeSlug}.pushify.dev.conf /etc/nginx/sites-available/${safeSlug}.pushify.dev.conf 2>/dev/null || true`,
    'nginx -t 2>/dev/null && nginx -s reload 2>/dev/null || true',
  ].join('; ');

  return [composeDown, stopAllMatching, filesystemAndNginx].filter(Boolean).join('; ');
}

async function serverHasProjectContainers(
  server: typeof servers.$inferSelect,
  slug: string
): Promise<boolean> {
  if (!server.ipv4 || !server.sshPrivateKey) return false;

  const safeSlug = shellEscapeSlug(slug);
  const base = `pushify-${safeSlug}`;
  const ssh = new SSHClient();
  try {
    await ssh.connect({
      host: server.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });
    const check = await ssh.exec(
      `docker ps -a --format '{{.Names}}' | grep -E '^${base}(-|$)|^pushify-preview-${safeSlug}' || true`
    );
    return !!check.stdout.trim();
  } catch {
    return false;
  } finally {
    ssh.disconnect();
  }
}

/**
 * Find the server that still hosts this project's containers.
 * Falls back when project.serverId is null (e.g. server row deleted).
 */
export async function resolveDeployServerForCleanup(
  project: ProjectRow
): Promise<typeof servers.$inferSelect | null> {
  if (project.serverId) {
    const byId = await db.query.servers.findFirst({
      where: eq(servers.id, project.serverId),
    });
    if (byId?.ipv4 && byId.sshPrivateKey) {
      return byId;
    }
    logger.warn(
      { projectId: project.id, serverId: project.serverId },
      'Project serverId missing SSH or IP — trying fallbacks'
    );
  }

  const settings = (project.settings || {}) as Record<string, unknown>;
  const productionUrl = settings.productionUrl as string | undefined;
  if (productionUrl) {
    try {
      const host = new URL(productionUrl).hostname;
      if (host && host !== 'localhost' && host !== '127.0.0.1') {
        const byHost = await db.query.servers.findFirst({
          where: and(
            eq(servers.organizationId, project.organizationId),
            eq(servers.ipv4, host)
          ),
        });
        if (byHost?.sshPrivateKey) {
          return byHost;
        }
      }
    } catch {
      /* ignore malformed URL */
    }
  }

  const orgServers = await db.query.servers.findMany({
    where: and(
      eq(servers.organizationId, project.organizationId),
      isNotNull(servers.ipv4)
    ),
  });

  for (const server of orgServers) {
    if (!server.sshPrivateKey) continue;
    if (await serverHasProjectContainers(server, project.slug)) {
      logger.info(
        { projectId: project.id, serverId: server.id, ipv4: server.ipv4 },
        'Resolved deploy server by scanning running containers'
      );
      return server;
    }
  }

  return null;
}

/** Stop running containers for a project (pause) without removing them. */
export async function pauseProjectContainersOnServer(ssh: SSHClient, slug: string): Promise<void> {
  const safeSlug = shellEscapeSlug(slug);
  const base = `pushify-${safeSlug}`;
  const projectDir = `/opt/pushify/apps/${safeSlug}`;
  const stopNames = `docker ps -q --format '{{.Names}}' | grep -E '^${base}(-|$)|^${base}-blue$|^${base}-green$' || true`;
  await ssh.exec(
    [
      `cd ${projectDir} 2>/dev/null && docker compose -p ${base} stop 2>/dev/null || true`,
      `ids=$(${stopNames}); if [ -n "$ids" ]; then docker stop $ids 2>/dev/null; fi`,
    ].join('; ')
  );
}

/** Start stopped containers for a project (resume). */
export async function resumeProjectContainersOnServer(ssh: SSHClient, slug: string): Promise<boolean> {
  const safeSlug = shellEscapeSlug(slug);
  const base = `pushify-${safeSlug}`;
  const projectDir = `/opt/pushify/apps/${safeSlug}`;
  const result = await ssh.exec(
    [
      `cd ${projectDir} 2>/dev/null && docker compose -p ${base} start 2>/dev/null || true`,
      `ids=$(docker ps -aq --filter "name=${base}" 2>/dev/null); if [ -n "$ids" ]; then docker start $ids 2>/dev/null; fi`,
    ].join('; ')
  );
  const check = await ssh.exec(
    `docker ps -q --filter "name=${base}" 2>/dev/null | head -1`
  );
  return !!check.stdout.trim() || result.code === 0;
}

export async function pauseProjectContainers(project: ProjectRow): Promise<boolean> {
  const remoteServer = await resolveDeployServerForCleanup(project);
  if (remoteServer?.ipv4 && remoteServer.sshPrivateKey) {
    const ssh = new SSHClient();
    try {
      await ssh.connect({
        host: remoteServer.ipv4,
        port: 22,
        username: 'root',
        privateKey: decrypt(remoteServer.sshPrivateKey),
      });
      await pauseProjectContainersOnServer(ssh, project.slug);
      logger.info({ projectId: project.id, slug: project.slug }, 'Paused remote containers');
      return true;
    } finally {
      ssh.disconnect();
    }
  }

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  const safeSlug = shellEscapeSlug(project.slug);
  const base = `pushify-${safeSlug}`;
  await execAsync(
    `ids=$(docker ps -q --filter "name=${base}" 2>/dev/null); if [ -n "$ids" ]; then docker stop $ids; fi`
  ).catch(() => undefined);
  return true;
}

export async function resumeProjectContainers(project: ProjectRow): Promise<boolean> {
  const remoteServer = await resolveDeployServerForCleanup(project);
  if (remoteServer?.ipv4 && remoteServer.sshPrivateKey) {
    const ssh = new SSHClient();
    try {
      await ssh.connect({
        host: remoteServer.ipv4,
        port: 22,
        username: 'root',
        privateKey: decrypt(remoteServer.sshPrivateKey),
      });
      return await resumeProjectContainersOnServer(ssh, project.slug);
    } finally {
      ssh.disconnect();
    }
  }

  const { execCommand } = await import('../workers/shell');
  const safeSlug = shellEscapeSlug(project.slug);
  const base = `pushify-${safeSlug}`;
  await execCommand(
    `ids=$(docker ps -aq --filter "name=${base}" 2>/dev/null); if [ -n "$ids" ]; then docker start $ids; fi`,
    { timeout: 30000 }
  ).catch(() => undefined);
  const { stdout } = await execCommand(`docker ps -q --filter "name=${base}" | head -1`, {
    timeout: 5000,
  });
  return !!stdout.trim();
}

export async function teardownProjectOnRemoteServer(
  server: typeof servers.$inferSelect,
  project: ProjectRow
): Promise<void> {
  if (!server.ipv4 || !server.sshPrivateKey) {
    throw new Error('Server has no SSH credentials for cleanup');
  }

  const settings = (project.settings || {}) as Record<string, unknown>;
  const isCompose = settings.deploymentType === 'docker-compose';
  const script = buildRemoteTeardownScript(project.slug, isCompose);

  const ssh = new SSHClient();
  try {
    await ssh.connect({
      host: server.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    const result = await ssh.exec(script);
    if (result.code !== 0) {
      logger.warn(
        { projectId: project.id, stderr: result.stderr, code: result.code },
        'Remote teardown script returned non-zero exit'
      );
    }

    try {
      await releasePort(ssh, project.slug);
    } catch (portErr) {
      logger.warn({ projectId: project.id, err: portErr }, 'Failed to release port from registry');
    }

    logger.info(
      { projectId: project.id, serverId: server.id, slug: project.slug },
      'Remote project containers and files cleaned up'
    );
  } finally {
    ssh.disconnect();
  }
}
