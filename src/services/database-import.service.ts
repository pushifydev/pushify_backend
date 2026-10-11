import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { requireOrgMember } from '../lib/org-access';
import { databaseRepository } from '../repositories/database.repository';
import { t, type SupportedLocale } from '../i18n';
import { decrypt } from '../lib/encryption';
import { SSHClient } from '../utils/ssh';
import { logger } from '../lib/logger';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { getOptionalRedis } from '../lib/redis-client';
import {
  appendLog,
  buildPgRestoreCommand,
  createImportJobStore,
  DatabaseImportError,
  detectPgDumpFormat,
  type ImportJob,
  type ImportJobStore,
} from '../lib/database-import';

let store: ImportJobStore | null = null;
function jobStore(): ImportJobStore {
  if (!store) store = createImportJobStore(getOptionalRedis());
  return store;
}

/** How often streamed pg_restore output is written to the job while it runs. */
const LOG_FLUSH_MS = 2000;

function importDir(databaseName: string): string {
  return `/opt/pushify/databases/${databaseName}/imports`;
}

/**
 * Import an uploaded pg_dump archive into a managed PostgreSQL database. Owner/admin only, as
 * restoring a backup. Returns a job right away; the restore runs in the background and its
 * status and pg_restore log are read with `getImport`.
 */
export const databaseImportService = {
  async startImport(
    databaseId: string,
    organizationId: string,
    userId: string,
    file: { name: string; bytes: Uint8Array },
    opts: { clean?: boolean },
    locale: SupportedLocale,
  ): Promise<ImportJob> {
    await requireOrgMember(organizationId, userId, 'admin', locale);

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }
    if (database.type !== 'postgresql') {
      throw new HTTPException(400, { message: 'Dump import is only available for PostgreSQL databases for now' });
    }
    if (database.status !== 'running') {
      throw new HTTPException(400, { message: t(locale, 'databases', 'databaseMustBeRunning') });
    }
    if (!database.serverId || !database.containerName) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'invalidContainer') });
    }

    let format;
    try {
      format = detectPgDumpFormat(file.bytes);
    } catch (err) {
      if (err instanceof DatabaseImportError) {
        throw new HTTPException(err.code === 'TOO_LARGE' ? 413 : 400, { message: err.message, cause: err.code });
      }
      throw err;
    }

    const server = await db.query.servers.findFirst({ where: eq(servers.id, database.serverId) });
    if (!server?.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
    }

    const jobs = jobStore();
    const job: ImportJob = {
      id: jobs.newId(),
      databaseId,
      organizationId,
      status: 'uploading',
      fileName: file.name,
      sizeBytes: file.bytes.length,
      format,
      clean: !!opts.clean,
      log: '',
      error: null,
      createdAt: new Date().toISOString(),
      finishedAt: null,
    };
    if (!(await jobs.acquire(databaseId, job.id))) {
      throw new HTTPException(409, { message: 'An import is already running for this database' });
    }
    await jobs.save(job);

    this.runImport(job, {
      server: { ipv4: server.ipv4, sshPrivateKey: server.sshPrivateKey },
      containerName: database.containerName,
      username: database.username,
      databaseName: database.databaseName,
      bytes: file.bytes,
    }).catch((error) => logger.error({ error, databaseId, jobId: job.id }, 'Database import crashed'));

    return job;
  },

  async getImport(
    databaseId: string,
    jobId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale,
  ): Promise<ImportJob> {
    await requireOrgMember(organizationId, userId, 'admin', locale);
    const job = await jobStore().get(jobId);
    if (!job || job.databaseId !== databaseId || job.organizationId !== organizationId) {
      throw new HTTPException(404, { message: 'Import not found' });
    }
    return job;
  },

  /** Internal: copy the archive to the server and pg_restore it. Never throws. */
  async runImport(
    job: ImportJob,
    target: {
      server: { ipv4: string; sshPrivateKey: string };
      containerName: string;
      username: string;
      databaseName: string;
      bytes: Uint8Array;
    },
  ): Promise<void> {
    const jobs = jobStore();
    const ssh = new SSHClient();
    let lastFlush = 0;
    const flush = async (force = false) => {
      if (!force && Date.now() - lastFlush < LOG_FLUSH_MS) return;
      lastFlush = Date.now();
      await jobs.save(job).catch((error) => logger.warn({ error, jobId: job.id }, 'Could not save import job'));
    };

    try {
      await ssh.connect({ host: target.server.ipv4, username: 'root', privateKey: decrypt(target.server.sshPrivateKey) });

      const dir = importDir(target.databaseName);
      const hostPath = `${dir}/${job.id}.dump`;
      await ssh.mkdir(dir);
      await ssh.uploadFile(Buffer.from(target.bytes), hostPath);
      job.log = appendLog(job.log, `Uploaded ${job.fileName} (${job.sizeBytes} bytes, ${job.format} format)\n`);

      job.status = 'restoring';
      await flush(true);

      const cmd = buildPgRestoreCommand(target.containerName, target.username, target.databaseName, hostPath, {
        clean: job.clean,
      });
      const onOutput = (chunk: string) => {
        job.log = appendLog(job.log, chunk);
        void flush();
      };
      const code = await ssh.execStream(cmd, onOutput, onOutput);

      if (code !== 0) {
        job.status = 'failed';
        job.error = 'pg_restore failed; the import was rolled back and the database was left unchanged. See the log.';
      } else {
        job.status = 'completed';
      }
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : 'Unknown error';
      logger.error({ error, databaseId: job.databaseId, jobId: job.id }, 'Database import failed');
    } finally {
      ssh.disconnect();
      job.finishedAt = new Date().toISOString();
      await flush(true);
      await jobs.release(job.databaseId).catch(() => {});
    }
  },
};
