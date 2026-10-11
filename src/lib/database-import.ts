import { randomUUID } from 'crypto';

/**
 * Importing a customer's own `pg_dump` into a managed PostgreSQL database (first step: Postgres
 * only, archive formats only). Pure helpers + the job store; the SSH side is in
 * services/database-import.service.ts.
 *
 * Safety: pg_restore runs with `--single-transaction --exit-on-error`, so a broken or
 * conflicting dump rolls back whole and leaves the database as it was.
 */

/** Upper bound for an uploaded dump. The body is held in memory while it is copied to the server. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
/** How much of pg_restore's output is kept per job (the tail wins). */
export const MAX_IMPORT_LOG_CHARS = 64 * 1024;
/** Jobs are kept this long after they start, then forgotten. */
export const IMPORT_JOB_TTL_MS = 24 * 60 * 60 * 1000;

export type PgDumpFormat = 'custom' | 'tar';

export class DatabaseImportError extends Error {
  constructor(
    public readonly code: 'EMPTY' | 'TOO_LARGE' | 'PLAIN_SQL' | 'NOT_A_DUMP',
    message: string,
  ) {
    super(message);
    this.name = 'DatabaseImportError';
  }
}

/**
 * Which pg_dump archive format these bytes are, or a clear error. pg_restore cannot read plain
 * SQL dumps, so those are refused with a hint rather than failing later on the server.
 */
export function detectPgDumpFormat(bytes: Uint8Array): PgDumpFormat {
  if (bytes.length === 0) throw new DatabaseImportError('EMPTY', 'The uploaded file is empty');
  if (bytes.length > MAX_IMPORT_BYTES) {
    throw new DatabaseImportError('TOO_LARGE', `A dump can be at most ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
  }
  const head = (from: number, len: number) => Buffer.from(bytes.subarray(from, from + len)).toString('latin1');
  if (head(0, 5) === 'PGDMP') return 'custom';
  // tar: "ustar" magic at offset 257 (pg_dump -Ft)
  if (bytes.length > 262 && head(257, 5) === 'ustar') return 'tar';
  const text = head(0, 512);
  if (/^\s*(--|SET |CREATE |BEGIN|\\connect)/m.test(text)) {
    throw new DatabaseImportError(
      'PLAIN_SQL',
      'This looks like a plain SQL dump. Create the dump with `pg_dump -Fc` (custom format) and upload that.',
    );
  }
  throw new DatabaseImportError('NOT_A_DUMP', 'This is not a pg_dump archive (expected `pg_dump -Fc` or `-Ft` output)');
}

function shellEscape(str: string): string {
  return `'${str.replace(/'/g, "'\\''")}'`;
}

/**
 * Shell command (root on the database's server) that restores the archive at `hostPath` into the
 * database and removes the file afterwards, whatever the outcome. pg_restore's verbose log goes
 * to stdout so it can be streamed back.
 *
 * - `--single-transaction --exit-on-error`: all or nothing; a bad dump changes nothing.
 * - `--no-owner --no-privileges`: dumps from other platforms name roles that don't exist here.
 * - `clean` (opt-in) drops the dump's objects before recreating them — still inside the transaction.
 */
export function buildPgRestoreCommand(
  containerName: string,
  username: string,
  databaseName: string,
  hostPath: string,
  opts: { clean?: boolean } = {},
): string {
  const fileName = hostPath.split('/').pop()!;
  const eCont = shellEscape(containerName);
  const eUser = shellEscape(username);
  const eDb = shellEscape(databaseName);
  const eHost = shellEscape(hostPath);
  const eTmp = shellEscape(`/tmp/${fileName}`);
  const clean = opts.clean ? ' --clean --if-exists' : '';
  return (
    `docker cp ${eHost} ${eCont}:${eTmp} && ` +
    `docker exec ${eCont} pg_restore --verbose --single-transaction --exit-on-error --no-owner --no-privileges${clean} ` +
    `-U ${eUser} -d ${eDb} ${eTmp} 2>&1; rc=$?; ` +
    `docker exec ${eCont} rm -f ${eTmp}; rm -f ${eHost}; exit $rc`
  );
}

/** Appends to a log, keeping only the last `max` characters. */
export function appendLog(log: string, chunk: string, max: number = MAX_IMPORT_LOG_CHARS): string {
  const next = log + chunk;
  return next.length > max ? next.slice(next.length - max) : next;
}

// ============ Job store ============

export type ImportJobStatus = 'uploading' | 'restoring' | 'completed' | 'failed';

export interface ImportJob {
  id: string;
  databaseId: string;
  organizationId: string;
  status: ImportJobStatus;
  fileName: string;
  sizeBytes: number;
  format: PgDumpFormat;
  clean: boolean;
  log: string;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}

/** The subset of ioredis used here, so tests can pass a fake. */
export interface ImportRedis {
  set(key: string, value: string, px: 'PX', ms: number): Promise<unknown>;
  set(key: string, value: string, px: 'PX', ms: number, nx: 'NX'): Promise<'OK' | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

const JOB_PREFIX = 'db-import:job:';
const LOCK_PREFIX = 'db-import:active:';

/**
 * Import jobs, in Redis (seen by every API process) or process memory without REDIS_URL. One
 * running import per database: `acquire` fails while another one holds the database.
 */
export function createImportJobStore(redis: ImportRedis | null) {
  const jobs = new Map<string, { job: ImportJob; expiresAt: number }>();
  const locks = new Map<string, { jobId: string; expiresAt: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of jobs) if (v.expiresAt < now) jobs.delete(k);
    for (const [k, v] of locks) if (v.expiresAt < now) locks.delete(k);
  };

  return {
    newId(): string {
      return randomUUID();
    },

    async acquire(databaseId: string, jobId: string): Promise<boolean> {
      if (redis) {
        return (await redis.set(LOCK_PREFIX + databaseId, jobId, 'PX', IMPORT_JOB_TTL_MS, 'NX')) === 'OK';
      }
      sweep();
      if (locks.has(databaseId)) return false;
      locks.set(databaseId, { jobId, expiresAt: Date.now() + IMPORT_JOB_TTL_MS });
      return true;
    },

    async release(databaseId: string): Promise<void> {
      if (redis) {
        await redis.del(LOCK_PREFIX + databaseId);
        return;
      }
      locks.delete(databaseId);
    },

    async save(job: ImportJob): Promise<void> {
      if (redis) {
        await redis.set(JOB_PREFIX + job.id, JSON.stringify(job), 'PX', IMPORT_JOB_TTL_MS);
        return;
      }
      sweep();
      jobs.set(job.id, { job: { ...job }, expiresAt: Date.now() + IMPORT_JOB_TTL_MS });
    },

    async get(jobId: string): Promise<ImportJob | null> {
      if (redis) {
        const raw = await redis.get(JOB_PREFIX + jobId);
        return raw ? (JSON.parse(raw) as ImportJob) : null;
      }
      const row = jobs.get(jobId);
      if (!row || row.expiresAt < Date.now()) return null;
      return { ...row.job };
    },
  };
}

export type ImportJobStore = ReturnType<typeof createImportJobStore>;
