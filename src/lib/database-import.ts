import { randomUUID } from 'crypto';
import { constants as zlibConstants, gunzipSync } from 'zlib';

/**
 * Importing a customer's own dump into a managed database: `pg_dump` archives (custom/tar) into
 * PostgreSQL, and plain `.sql` / `.sql.gz` (mysqldump / mariadb-dump) into MySQL. Pure helpers +
 * the job store; the SSH side is in services/database-import.service.ts.
 *
 * Safety:
 * - PostgreSQL: pg_restore runs with `--single-transaction --exit-on-error`, so a broken or
 *   conflicting dump rolls back whole and leaves the database as it was.
 * - MySQL: the client stops at the first failing statement and exits non-zero. MySQL commits DDL
 *   implicitly, so statements before the error stay applied; the job fails with an error that
 *   says so instead of claiming a rollback.
 */

/** Upper bound for an uploaded dump. The body is held in memory while it is copied to the server. */
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
/** How much of pg_restore's output is kept per job (the tail wins). */
export const MAX_IMPORT_LOG_CHARS = 64 * 1024;
/** Jobs are kept this long after they start, then forgotten. */
export const IMPORT_JOB_TTL_MS = 24 * 60 * 60 * 1000;

export type PgDumpFormat = 'custom' | 'tar';
export type MysqlDumpFormat = 'sql' | 'sql.gz';
export type DumpFormat = PgDumpFormat | MysqlDumpFormat;

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
function assertImportSize(bytes: Uint8Array): void {
  if (bytes.length === 0) throw new DatabaseImportError('EMPTY', 'The uploaded file is empty');
  if (bytes.length > MAX_IMPORT_BYTES) {
    throw new DatabaseImportError('TOO_LARGE', `A dump can be at most ${MAX_IMPORT_BYTES / 1024 / 1024} MB`);
  }
}

export function detectPgDumpFormat(bytes: Uint8Array): PgDumpFormat {
  assertImportSize(bytes);
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

/** How much compressed input is inflated to look at the start of a `.sql.gz`. */
const GZIP_SNIFF_BYTES = 16 * 1024;

/**
 * Whether these bytes are a plain SQL dump for MySQL (`mysqldump` / `mariadb-dump` output),
 * optionally gzip-compressed, or a clear error. Only the start of the file is inspected; a corrupt
 * gzip stream further in is caught on the server (`gunzip -t`) before anything is imported.
 */
export function detectMysqlDumpFormat(bytes: Uint8Array): MysqlDumpFormat {
  assertImportSize(bytes);
  const gz = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
  let head: string;
  if (gz) {
    try {
      // Z_SYNC_FLUSH: inflate a truncated prefix without "unexpected end of file".
      head = gunzipSync(bytes.subarray(0, GZIP_SNIFF_BYTES), { finishFlush: zlibConstants.Z_SYNC_FLUSH })
        .subarray(0, 4096)
        .toString('latin1');
    } catch {
      throw new DatabaseImportError('NOT_A_DUMP', 'This .gz file could not be decompressed');
    }
  } else {
    head = Buffer.from(bytes.subarray(0, 4096)).toString('latin1');
  }
  if (head.startsWith('PGDMP') || /PostgreSQL database dump/.test(head)) {
    throw new DatabaseImportError('NOT_A_DUMP', 'This is a PostgreSQL dump; it cannot be imported into a MySQL database');
  }
  if (!head.includes('\0') && /^\s*(--|\/\*|#|SET |CREATE |INSERT |DROP |USE |LOCK |START TRANSACTION|BEGIN)/im.test(head)) {
    return gz ? 'sql.gz' : 'sql';
  }
  throw new DatabaseImportError(
    'NOT_A_DUMP',
    'This is not a SQL dump (expected `mysqldump` / `mariadb-dump` output as .sql or .sql.gz)',
  );
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

/**
 * Shell command (root on the database's server) that feeds the `.sql` / `.sql.gz` at `hostPath`
 * into the database with the mysql client and removes the file afterwards, whatever the outcome.
 *
 * - The dump is streamed over `docker exec -i` stdin, so nothing is copied into the container.
 * - `.sql.gz` is checked whole with `gunzip -t` first, so a truncated upload imports nothing.
 * - Without `--force` the client stops at the first error and exits non-zero.
 */
export function buildMysqlImportCommand(
  containerName: string,
  username: string,
  password: string,
  databaseName: string,
  hostPath: string,
  format: MysqlDumpFormat,
): string {
  const eCont = shellEscape(containerName);
  const eUser = shellEscape(username);
  const ePass = shellEscape(password);
  const eDb = shellEscape(databaseName);
  const eHost = shellEscape(hostPath);
  const client = `docker exec -i -e MYSQL_PWD=${ePass} ${eCont} mysql --show-warnings -u ${eUser} ${eDb}`;
  const run =
    format === 'sql.gz'
      ? `gunzip -t ${eHost} 2>&1 && gunzip -c ${eHost} | ${client} 2>&1`
      : `${client} < ${eHost} 2>&1`;
  return `${run}; rc=$?; rm -f ${eHost}; exit $rc`;
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
  format: DumpFormat;
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
