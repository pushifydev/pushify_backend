import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { decrypt } from './encryption';
import { SSHClient } from '../utils/ssh';
import { logger } from './logger';

/**
 * Upload rendered HTML into the project's container at /var/www/html/pushify-site/index.html
 */
export async function publishSiteHtmlToServer(
  projectId: string,
  slug: string,
  serverId: string | null,
  html: string,
): Promise<{ publishedPath: string; publicPath: string } | null> {
  if (!serverId) return null;

  const server = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });

  if (!server?.ipv4 || !server.sshPrivateKey) return null;

  const container = `pushify-${slug}`;
  const remotePath = '/var/www/html/pushify-site/index.html';
  const b64 = Buffer.from(html, 'utf8').toString('base64');

  const ssh = new SSHClient();
  try {
    await ssh.connect({
      host: server.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    const script = [
      `docker exec ${container} mkdir -p /var/www/html/pushify-site 2>/dev/null || mkdir -p /opt/pushify/site-studio/${slug}`,
      `echo '${b64}' | base64 -d | docker exec -i ${container} tee ${remotePath} > /dev/null 2>&1 || echo '${b64}' | base64 -d > /opt/pushify/site-studio/${slug}/index.html`,
    ].join(' && ');

    const result = await ssh.exec(script);
    if (result.code !== 0) {
      logger.warn({ projectId, stderr: result.stderr }, 'Site HTML publish command non-zero exit');
    }

    return {
      publishedPath: remotePath,
      publicPath: '/pushify-site/',
    };
  } catch (err) {
    logger.warn({ err, projectId }, 'Failed to publish site HTML via SSH');
    return null;
  } finally {
    ssh.disconnect();
  }
}

/**
 * Publish multiple rendered pages. Each file is written to the project's container at
 * /var/www/html/pushify-site/<path>, falling back to the host static dir
 * /opt/pushify/site-studio/<slug>/<path> when there is no container (static sites).
 */
export async function publishSiteFilesToServer(
  projectId: string,
  slug: string,
  serverId: string | null,
  files: { path: string; html: string }[],
): Promise<{ publishedPath: string; publicPath: string } | null> {
  if (!serverId || files.length === 0) return null;

  const server = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });
  if (!server?.ipv4 || !server.sshPrivateKey) return null;

  const container = `pushify-${slug}`;
  const ssh = new SSHClient();
  try {
    await ssh.connect({
      host: server.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    for (const file of files) {
      const b64 = Buffer.from(file.html, 'utf8').toString('base64');
      const containerPath = `/var/www/html/pushify-site/${file.path}`;
      const staticPath = `/opt/pushify/site-studio/${slug}/${file.path}`;
      const containerDir = containerPath.slice(0, containerPath.lastIndexOf('/'));
      const staticDir = staticPath.slice(0, staticPath.lastIndexOf('/'));
      const script =
        `(docker exec ${container} mkdir -p ${containerDir} 2>/dev/null && ` +
        `echo '${b64}' | base64 -d | docker exec -i ${container} tee ${containerPath} >/dev/null 2>&1) || ` +
        `(mkdir -p ${staticDir} && echo '${b64}' | base64 -d > ${staticPath})`;
      const result = await ssh.exec(script);
      if (result.code !== 0) {
        logger.warn({ projectId, path: file.path, stderr: result.stderr }, 'Site file publish non-zero exit');
      }
    }

    return { publishedPath: '/var/www/html/pushify-site/', publicPath: '/pushify-site/' };
  } catch (err) {
    logger.warn({ err, projectId }, 'Failed to publish site files via SSH');
    return null;
  } finally {
    ssh.disconnect();
  }
}

export async function getProjectProductionUrl(projectId: string): Promise<string | null> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    with: { domains: true },
  });

  if (!project) return null;

  const primary = project.domains?.find((d) => d.isPrimary) ?? project.domains?.[0];
  if (primary?.domain) {
    return `https://${primary.domain}`;
  }

  const settings = (project.settings || {}) as Record<string, unknown>;
  if (typeof settings.productionUrl === 'string') {
    return settings.productionUrl;
  }

  return null;
}
