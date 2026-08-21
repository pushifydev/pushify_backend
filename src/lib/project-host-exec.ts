import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { getSSHConnection } from '../utils/ssh';
import { decrypt } from './encryption';
import { resolveProjectServerId } from './runner-routing';

type Project = typeof projects.$inferSelect;

/**
 * Run a shell command on the project's deploy host — over SSH for server/runner
 * targets, locally when the control plane is the deploy host itself.
 */
export async function execOnProjectHost(
  project: Project,
  command: string
): Promise<{ ok: boolean; stdout: string }> {
  const targetServerId = resolveProjectServerId(project);
  if (targetServerId) {
    const server = await db.query.servers.findFirst({ where: eq(servers.id, targetServerId) });
    if (!server?.ipv4 || !server.sshPrivateKey) {
      return { ok: false, stdout: '' };
    }
    // A non-running server can't answer SSH — fail fast instead of a handshake timeout
    if (server.status !== 'running') {
      return { ok: false, stdout: '' };
    }
    const ssh = await getSSHConnection({
      host: server.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });
    try {
      const result = await ssh.exec(command);
      return { ok: result.code === 0, stdout: result.stdout };
    } finally {
      ssh.disconnect();
    }
  }

  const { execFile } = await import('node:child_process');
  return await new Promise((resolve) => {
    execFile('sh', ['-c', command], { timeout: 60_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve({ ok: !error, stdout: String(stdout) });
    });
  });
}
