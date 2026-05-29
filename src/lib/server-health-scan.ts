import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { decrypt } from './encryption';
import { checkServerDiskSpace, type ServerDiskCheckResult } from './server-disk-check';
import { SSHClient } from '../utils/ssh';

export interface OrphanContainer {
  name: string;
  slug: string;
  status: string;
  ports: string;
}

export interface ServerHealthReport {
  disk: ServerDiskCheckResult;
  orphans: OrphanContainer[];
  pushifyContainerCount: number;
}

function containerMatchesProjectSlug(containerName: string, slug: string): boolean {
  return (
    containerName === `pushify-${slug}` ||
    containerName.startsWith(`pushify-${slug}-`)
  );
}

/**
 * Scan a deployment server for disk usage and Pushify containers not tied to an active project.
 */
export type ServerHealthScanTarget = {
  ipv4: string | null;
  sshPrivateKey: string | null;
};

export async function scanServerHealth(
  server: ServerHealthScanTarget,
  organizationId: string
): Promise<ServerHealthReport> {
  if (!server.ipv4 || !server.sshPrivateKey) {
    throw new Error('Server is not reachable via SSH');
  }

  const ssh = new SSHClient();
  await ssh.connect({
    host: server.ipv4,
    port: 22,
    username: 'root',
    privateKey: decrypt(server.sshPrivateKey),
  });

  try {
    const disk = await checkServerDiskSpace(ssh);

    const listResult = await ssh.exec(
      `docker ps -a --filter "name=pushify-" --format '{{.Names}}|{{.Status}}|{{.Ports}}' 2>/dev/null || true`
    );

    const activeProjects = await db
      .select({ slug: projects.slug })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, organizationId),
          ne(projects.status, 'deleted')
        )
      );

    const knownSlugs = new Set(activeProjects.map((p) => p.slug));
    const orphans: OrphanContainer[] = [];
    const lines = listResult.stdout.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const [name, status = '', ports = ''] = line.split('|');
      if (!name?.startsWith('pushify-')) continue;
      const matchedSlug = [...knownSlugs].find((slug) => containerMatchesProjectSlug(name, slug));
      const slug =
        matchedSlug ??
        name.replace(/^pushify-/, '').replace(/-(blue|green|db)$/, '').split('-pr-')[0] ??
        name;
      if (!matchedSlug) {
        orphans.push({ name, slug, status, ports });
      }
    }

    return {
      disk,
      orphans,
      pushifyContainerCount: lines.length,
    };
  } finally {
    ssh.disconnect();
  }
}
