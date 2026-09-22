import { spawn } from 'child_process';
import { pipeline } from 'stream/promises';
import { Readable, Writable } from 'stream';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import {
  catArgs,
  offsiteConfigured,
  pruneArgs,
  purgeArgs,
  rcatArgs,
  remoteDatabasePrefix,
  remoteObjectPath,
  type BackupLocation,
} from '../lib/offsite-backup';
import type { SSHClient } from '../utils/ssh';

/**
 * Moving customer database dumps off the server they were made on.
 *
 * rclone does the talking, on the control plane, with the operator's credentials — so a
 * compromised customer server cannot read or delete anyone's backups. The dump is streamed
 * through: SFTP read → rclone stdin → the remote, so a 40 GB database does not need 40 GB of
 * disk here, or 40 GB of memory.
 */

const RCLONE = env.RCLONE_BIN || 'rclone';

export interface OffsiteResult {
  status: 'uploaded' | 'skipped' | 'failed';
  path?: string;
  error?: string;
}

function remote(): string | null {
  return offsiteConfigured(env.DB_BACKUP_RCLONE_REMOTE) ? env.DB_BACKUP_RCLONE_REMOTE.trim() : null;
}

export function offsiteEnabled(): boolean {
  return remote() !== null;
}

/** Run rclone, optionally feeding it `input` and/or reading its stdout into `output`. */
async function runRclone(
  args: string[],
  streams: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}
): Promise<{ code: number; stderr: string }> {
  const child = spawn(RCLONE, args, { stdio: ['pipe', 'pipe', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => {
    // Enough to explain a failure, not enough to fill the log with progress
    if (stderr.length < 8000) stderr += chunk.toString();
  });

  const work: Promise<unknown>[] = [
    new Promise<{ code: number }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve({ code: code ?? 1 }));
    }),
  ];

  if (streams.input) {
    work.push(pipeline(streams.input as Readable, child.stdin));
  } else {
    child.stdin.end();
  }
  if (streams.output) {
    work.push(pipeline(child.stdout, streams.output as Writable));
  } else {
    child.stdout.resume();
  }

  const [exit] = (await Promise.all(work)) as [{ code: number }];
  return { code: exit.code, stderr: stderr.trim() };
}

export const offsiteBackupService = {
  /**
   * Copy a finished dump off the server. Never throws: a backup that exists on the server but
   * not off-site is still a backup, and failing the whole job would leave the customer with
   * neither. The outcome is recorded so the dashboard can say which copies exist.
   */
  async upload(ssh: SSHClient, localPath: string, location: BackupLocation): Promise<OffsiteResult> {
    const target = remote();
    if (!target) return { status: 'skipped' };

    const path = remoteObjectPath(target, location);
    try {
      const source = await ssh.openReadStream(localPath);
      const { code, stderr } = await runRclone(rcatArgs(path), { input: source });
      if (code !== 0) {
        logger.error({ path, stderr }, 'Off-site backup upload failed');
        return { status: 'failed', error: stderr || `rclone exited ${code}` };
      }
      logger.info({ path }, 'Backup copied off-site');
      return { status: 'uploaded', path };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      logger.error({ path, err }, 'Off-site backup upload failed');
      return { status: 'failed', error };
    }
  },

  /**
   * Read a backup back from the remote and write it onto a server — how a restore works when
   * the original server is gone, which is the case the off-site copy exists for.
   */
  async download(ssh: SSHClient, remotePath: string, destinationPath: string): Promise<boolean> {
    if (!remote()) return false;
    try {
      const upload = await ssh.openWriteStream(destinationPath);
      const { code, stderr } = await runRclone(catArgs(remotePath), { output: upload });
      if (code !== 0) {
        logger.error({ remotePath, stderr }, 'Off-site backup download failed');
        return false;
      }
      return true;
    } catch (err) {
      logger.error({ remotePath, err }, 'Off-site backup download failed');
      return false;
    }
  },

  /** Drop off-site copies past their retention, for one database. */
  async prune(organizationId: string, databaseId: string, keepDays: number): Promise<void> {
    const target = remote();
    if (!target) return;
    const prefix = remoteDatabasePrefix(target, organizationId, databaseId);
    const { code, stderr } = await runRclone(pruneArgs(prefix, keepDays));
    if (code !== 0) logger.warn({ prefix, stderr }, 'Off-site backup prune failed');
  },

  /** Everything of a database, when the database is deleted. */
  async purge(organizationId: string, databaseId: string): Promise<void> {
    const target = remote();
    if (!target) return;
    const prefix = remoteDatabasePrefix(target, organizationId, databaseId);
    const { code, stderr } = await runRclone(purgeArgs(prefix));
    // "directory not found" is the normal answer for a database that never had a backup
    if (code !== 0 && !/not found/i.test(stderr)) {
      logger.warn({ prefix, stderr }, 'Off-site backup purge failed');
    }
  },
};
