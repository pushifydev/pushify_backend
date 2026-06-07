import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { decrypt } from './encryption';
import { SSHClient } from '../utils/ssh';
import { logger } from './logger';
import { getProjectProductionUrl } from './site-editor-publish';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function validateSiteImage(file: File): { ext: string } {
  if (!ALLOWED_MIME[file.type]) {
    throw new Error('Only JPEG, PNG, WebP and GIF images are allowed');
  }
  if (file.size > MAX_BYTES) {
    throw new Error('Image must be 5MB or smaller');
  }
  return { ext: ALLOWED_MIME[file.type] };
}

export async function uploadSiteEditorImage(
  projectId: string,
  file: File,
): Promise<{ path: string; url: string | null; dataUrl?: string }> {
  const { ext } = validateSiteImage(file);
  const buffer = Buffer.from(await file.arrayBuffer());
  const filename = `${randomUUID()}.${ext}`;
  const assetPath = `/pushify-site/assets/${filename}`;
  const remotePath = `/var/www/html/pushify-site/assets/${filename}`;

  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project?.serverId) {
    const dataUrl = `data:${file.type};base64,${buffer.toString('base64')}`;
    return { path: assetPath, url: null, dataUrl };
  }

  const server = await db.query.servers.findFirst({
    where: eq(servers.id, project.serverId),
  });

  if (!server?.ipv4 || !server.sshPrivateKey) {
    const dataUrl = `data:${file.type};base64,${buffer.toString('base64')}`;
    return { path: assetPath, url: null, dataUrl };
  }

  const container = `pushify-${project.slug}`;
  const b64 = buffer.toString('base64');

  const ssh = new SSHClient();
  try {
    await ssh.connect({
      host: server.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    const script = [
      `docker exec ${container} mkdir -p /var/www/html/pushify-site/assets 2>/dev/null || mkdir -p /opt/pushify/site-studio/${project.slug}/assets`,
      `echo '${b64}' | base64 -d | docker exec -i ${container} tee ${remotePath} > /dev/null 2>&1 || echo '${b64}' | base64 -d > /opt/pushify/site-studio/${project.slug}/assets/${filename}`,
    ].join(' && ');

    const result = await ssh.exec(script);
    if (result.code !== 0) {
      logger.warn({ projectId, stderr: result.stderr }, 'Site asset upload non-zero exit');
      const dataUrl = `data:${file.type};base64,${buffer.toString('base64')}`;
      return { path: assetPath, url: null, dataUrl };
    }

    const baseUrl = await getProjectProductionUrl(projectId);
    const url = baseUrl ? `${baseUrl.replace(/\/$/, '')}${assetPath}` : assetPath;

    return { path: assetPath, url };
  } catch (err) {
    logger.warn({ err, projectId }, 'Site asset SSH upload failed');
    const dataUrl = `data:${file.type};base64,${buffer.toString('base64')}`;
    return { path: assetPath, url: null, dataUrl };
  } finally {
    ssh.disconnect();
  }
}
