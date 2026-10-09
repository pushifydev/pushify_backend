import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import type { projects } from '../db/schema/projects';
import { decrypt } from './encryption';
import { logger } from './logger';
import { getSSHConnection, SSHClient } from '../utils/ssh';
import { releasePort } from '../workers/port-manager';
import { projectImageReferenceFilters } from './project-image-names';
import { staticSiteKey } from './static-upload';
import { pickRunnerServerId } from './runner-routing';
import { env } from '../config/env';
import {
  projectContainerPattern,
  projectContainerNames,
  runnerSlugConflicts,
  type ProjectContainerNames,
} from './project-containers';

type ProjectRow = typeof projects.$inferSelect;

function shellEscapeSlug(slug: string): string {
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new Error(`Invalid project slug for cleanup: ${slug}`);
  }
  return slug;
}

/** Build remote shell script that stops every Pushify container for this slug. */
/** Remove a static site's files and Nginx vhost (Site Studio or uploaded). */
export function buildStaticTeardownScript(siteKey: string): string {
  const key = shellEscapeSlug(siteKey);
  return [
    `rm -rf /opt/pushify/site-studio/${key} /opt/pushify/site-studio/${key}.new /opt/pushify/site-studio/${key}.old`,
    `rm -f /etc/nginx/conf.d/pushify-${key}.conf /opt/pushify/nginx/pushify-${key}.conf`,
    'nginx -t >/dev/null 2>&1 && (systemctl reload nginx 2>/dev/null || nginx -s reload) || true',
  ].join('; ');
}

/**
 * Remove everything a project put on a host. Matches by exact names only (project-containers.ts):
 * on a shared runner, "anything starting with pushify-<slug>-" is other organizations' apps.
 * `names` carries the project's worker and volume names from the database; without it, workers
 * and named volumes are left alone rather than guessed.
 */
export function buildRemoteTeardownScript(slug: string, isCompose: boolean, names?: ProjectContainerNames): string {
  const safeSlug = shellEscapeSlug(slug);
  const base = `pushify-${safeSlug}`;
  const projectDir = `/opt/pushify/apps/${safeSlug}`;
  const pattern = projectContainerPattern(safeSlug, names?.workers ?? []);

  const stopAllMatching = [
    `ids=$(docker ps -a --format '{{.Names}}' | grep -E '${pattern}' || true)`,
    'if [ -n "$ids" ]; then docker rm -f $ids 2>/dev/null || true; fi',
    `docker network rm ${base}-net 2>/dev/null || true`,
  ].join('; ');

  const composeDown = isCompose
    ? [
        `cd ${projectDir} 2>/dev/null && docker compose -p ${base} down -v 2>/dev/null || true`,
        // A customer's own compose file lives in their checkout, not in the project directory
        `cd ${projectDir}/repo 2>/dev/null && docker compose -p ${base} down -v --remove-orphans 2>/dev/null || true`,
        // Compose labels its containers with the project name — exact, unlike a name prefix
        `docker ps -aq --filter label=com.docker.compose.project=${base} | xargs -r docker rm -f 2>/dev/null || true`,
        // Compose names its own network <project>_default and leaves it behind
        `docker network rm ${base}_default 2>/dev/null || true`,
      ].join('; ')
    : '';

  // Reclaim disk by removing the project's built images (the big space consumer that
  // container removal alone leaves behind): the image in both naming forms plus its preview
  // builds, and nothing that merely shares the slug as a prefix. Runs after containers are gone.
  const listImages = projectImageReferenceFilters(safeSlug)
    .map((ref) => `docker images -q --filter=reference='${ref}'`)
    .join('; ');
  const removeImages = `{ ${listImages}; } | sort -u | xargs -r docker rmi -f 2>/dev/null || true`;

  // Remove the project's persistent named volumes (pushify-vol-<slug>-*) — data is gone
  // with the project, matching user expectation on delete.
  // By exact name only: pushify-vol-<slug>-<name> cannot tell slug "a" + volume "shop-data"
  // from slug "a-shop" + volume "data", so a prefix filter deleted other projects' data.
  const volumeNames = (names?.volumes ?? []).filter((v) => /^pushify-vol-[a-z0-9-]+$/.test(v));
  const removeVolumes = volumeNames.length
    ? `docker volume rm ${volumeNames.join(' ')} 2>/dev/null || true`
    : 'true';

  const filesystemAndNginx = [
    `rm -rf ${projectDir}`,
    `rm -f /etc/nginx/conf.d/${safeSlug}.pushify.dev.conf /etc/nginx/sites-enabled/${safeSlug}.pushify.dev.conf /etc/nginx/sites-available/${safeSlug}.pushify.dev.conf 2>/dev/null || true`,
    // The vhosts the deployer actually writes (`pushify-<slug>` for the auto-subdomain, one
    // `pushify-<slug>-pr-N` per PR preview) — left behind, they kept proxying to dead ports.
    `rm -f /etc/nginx/sites-enabled/pushify-${safeSlug} /etc/nginx/sites-available/pushify-${safeSlug} /opt/pushify/nginx/pushify-${safeSlug}.conf 2>/dev/null || true`,
    // A domain-less app's public-port site (workers/public-port-proxy.ts)
    `rm -f /etc/nginx/sites-enabled/pushify-${safeSlug}.port /etc/nginx/sites-available/pushify-${safeSlug}.port /etc/nginx/sites-available/pushify-${safeSlug}.port.prev 2>/dev/null || true`,
    // PR previews: -pr-<number> exactly (a glob would also take another project's "<slug>-pr-x")
    `find /etc/nginx/sites-enabled /etc/nginx/sites-available /opt/pushify/nginx /etc/nginx/conf.d -maxdepth 1 -regextype posix-extended -regex '.*/(pushify-${safeSlug}-pr-[0-9]+(\\.conf)?|preview-${safeSlug}-pr-[0-9]+\\.conf)' -delete 2>/dev/null || true`,
    'nginx -t 2>/dev/null && nginx -s reload 2>/dev/null || true',
  ].join('; ');

  return [composeDown, stopAllMatching, removeImages, removeVolumes, filesystemAndNginx].filter(Boolean).join('; ');
}

async function serverHasProjectContainers(
  server: typeof servers.$inferSelect,
  slug: string
): Promise<boolean> {
  if (!server.ipv4 || !server.sshPrivateKey) return false;

  const safeSlug = shellEscapeSlug(slug);
  const ssh = await getSSHConnection({
    host: server.ipv4,
    port: 22,
    username: 'root',
    privateKey: decrypt(server.sshPrivateKey),
  });
  try {
    const check = await ssh.exec(
      `docker ps -a --format '{{.Names}}' | grep -E '${projectContainerPattern(safeSlug)}' || true`
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
 *
 * A project without a server runs on a Pushify shared runner (`pickRunnerServerId`, the same
 * sticky choice the deploy made). The runner belongs to Pushify, not to the customer's
 * organization, so the organization fallbacks below can never find it — before this check,
 * pausing, suspending or deleting a runner project silently did nothing to its containers.
 */
export async function resolveDeployServerForCleanup(
  project: ProjectRow
): Promise<typeof servers.$inferSelect | null> {
  if (!project.serverId) {
    const runnerId = pickRunnerServerId(project.id);
    if (runnerId) {
      const runner = await db.query.servers.findFirst({ where: eq(servers.id, runnerId) });
      if (runner?.ipv4 && runner.sshPrivateKey) return runner;
      logger.warn({ projectId: project.id, runnerId }, 'Shared runner missing SSH or IP — trying fallbacks');
    }
  }

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

/**
 * Stop running containers for a project (pause) without removing them. True when none of the
 * project's containers is left running afterwards.
 */
export async function pauseProjectContainersOnServer(
  ssh: SSHClient,
  slug: string,
  workerNames: string[] = [],
): Promise<boolean> {
  const safeSlug = shellEscapeSlug(slug);
  const base = `pushify-${safeSlug}`;
  const projectDir = `/opt/pushify/apps/${safeSlug}`;
  const running =
    `{ docker ps --format '{{.Names}}' | grep -E '${projectContainerPattern(safeSlug, workerNames)}'; ` +
    `docker ps --filter label=com.docker.compose.project=${base} --format '{{.Names}}'; } | sort -u || true`;
  await ssh.exec(
    [
      `cd ${projectDir} 2>/dev/null && docker compose -p ${base} stop 2>/dev/null || true`,
      `ids=$(${running}); if [ -n "$ids" ]; then docker stop $ids 2>/dev/null; fi`,
    ].join('; ')
  );
  const left = await ssh.exec(running);
  return !left.stdout.trim();
}

/** Start stopped containers for a project (resume). */
export async function resumeProjectContainersOnServer(
  ssh: SSHClient,
  slug: string,
  workerNames: string[] = [],
): Promise<boolean> {
  const safeSlug = shellEscapeSlug(slug);
  const base = `pushify-${safeSlug}`;
  const projectDir = `/opt/pushify/apps/${safeSlug}`;
  const pattern = projectContainerPattern(safeSlug, workerNames);
  const result = await ssh.exec(
    [
      `cd ${projectDir} 2>/dev/null && docker compose -p ${base} start 2>/dev/null || true`,
      `ids=$(docker ps -a --format '{{.Names}}' | grep -E '${pattern}' || true); if [ -n "$ids" ]; then docker start $ids 2>/dev/null; fi`,
    ].join('; ')
  );
  const check = await ssh.exec(`docker ps --format '{{.Names}}' | grep -E '${pattern}' | head -1 || true`);
  return !!check.stdout.trim() || result.code === 0;
}

/**
 * On a shared runner, refuse to act on a slug another live project also answers to — its
 * containers, files and ports carry the same names, so "this project's" would include theirs.
 */
async function blockedBySlugConflict(project: ProjectRow, action: string, activeOnly: boolean): Promise<boolean> {
  const conflicts = await runnerSlugConflicts(project, { activeOnly });
  if (conflicts.length === 0) return false;
  logger.error(
    { projectId: project.id, slug: project.slug, conflicts: conflicts.map((c) => ({ id: c.id, slug: c.slug, status: c.status })) },
    `${action} skipped on the shared runner: another project uses a conflicting slug`,
  );
  return true;
}

export async function pauseProjectContainers(project: ProjectRow): Promise<boolean> {
  // Pausing a slug an active project elsewhere shares would stop that project too
  if (await blockedBySlugConflict(project, 'Pause', true)) return false;
  const remoteServer = await resolveDeployServerForCleanup(project);
  if (remoteServer?.ipv4 && remoteServer.sshPrivateKey) {
    const { workers } = await projectContainerNames(project.id, project.slug);
    const ssh = await getSSHConnection({
      host: remoteServer.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(remoteServer.sshPrivateKey),
    });
    try {
      const stopped = await pauseProjectContainersOnServer(ssh, project.slug, workers);
      logger.info({ projectId: project.id, slug: project.slug, stopped }, 'Paused remote containers');
      return stopped;
    } finally {
      ssh.disconnect();
    }
  }

  // No server found. In production the control plane runs no customer containers, so there is
  // nothing local to stop — report it instead of claiming success.
  if (!(env.PUSHIFY_ALLOW_LOCAL_DEPLOYS ?? env.NODE_ENV !== 'production')) {
    logger.warn({ projectId: project.id, slug: project.slug }, 'Pause: no server found for the project; nothing was stopped');
    return false;
  }
  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  const safeSlug = shellEscapeSlug(project.slug);
  await execAsync(
    `ids=$(docker ps --format '{{.Names}}' | grep -E '${projectContainerPattern(safeSlug)}' || true); if [ -n "$ids" ]; then docker stop $ids; fi`
  ).catch(() => undefined);
  return true;
}

export async function resumeProjectContainers(project: ProjectRow): Promise<boolean> {
  // Starting a shared slug could start someone else's stopped (or suspended) containers
  if (await blockedBySlugConflict(project, 'Resume', false)) return false;
  const remoteServer = await resolveDeployServerForCleanup(project);
  if (remoteServer?.ipv4 && remoteServer.sshPrivateKey) {
    const { workers } = await projectContainerNames(project.id, project.slug);
    const ssh = await getSSHConnection({
      host: remoteServer.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(remoteServer.sshPrivateKey),
    });
    try {
      return await resumeProjectContainersOnServer(ssh, project.slug, workers);
    } finally {
      ssh.disconnect();
    }
  }

  const { execCommand } = await import('../workers/shell');
  const safeSlug = shellEscapeSlug(project.slug);
  const pattern = projectContainerPattern(safeSlug);
  await execCommand(
    `ids=$(docker ps -a --format '{{.Names}}' | grep -E '${pattern}' || true); if [ -n "$ids" ]; then docker start $ids; fi`,
    { timeout: 30000 }
  ).catch(() => undefined);
  const { stdout } = await execCommand(`docker ps --format '{{.Names}}' | grep -E '${pattern}' | head -1 || true`, {
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
  // A marketplace stack, or a project deploying its own compose file
  const isCompose = settings.deploymentType === 'docker-compose' || !!project.composePath;
  // A static site has no container: remove its files and vhost only. The container teardown
  // matches by slug, which on a shared runner could hit another organisation's project.
  if (settings.static !== true && (await blockedBySlugConflict(project, 'Teardown', false))) {
    // Leave the files and containers in place: removing them would remove the other project's.
    return;
  }
  const script = settings.static === true
    ? buildStaticTeardownScript(staticSiteKey(project))
    : buildRemoteTeardownScript(project.slug, isCompose, await projectContainerNames(project.id, project.slug));

  const ssh = await getSSHConnection({
    host: server.ipv4,
    port: 22,
    username: 'root',
    privateKey: decrypt(server.sshPrivateKey),
  });
  try {

    const result = await ssh.exec(script);
    if (result.code !== 0) {
      logger.warn(
        { projectId: project.id, stderr: result.stderr, code: result.code },
        'Remote teardown script returned non-zero exit'
      );
    }

    try {
      if (settings.static === true) await releasePort(ssh, staticSiteKey(project));
      await releasePort(ssh, project.slug);
      await releasePort(ssh, `${project.slug}:public`);
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
