import { describe, it, expect } from 'vitest';
import {
  appendLog,
  buildPgRestoreCommand,
  createImportJobStore,
  DatabaseImportError,
  detectPgDumpFormat,
  MAX_IMPORT_BYTES,
  type ImportJob,
  type ImportRedis,
} from './database-import';

const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof DatabaseImportError ? err.code : 'other';
  }
  return undefined;
}

describe('detectPgDumpFormat', () => {
  it('recognises custom-format archives (pg_dump -Fc)', () => {
    expect(detectPgDumpFormat(bytes('PGDMP\x01\x0e\x00rest'))).toBe('custom');
  });

  it('recognises tar archives (pg_dump -Ft)', () => {
    const tar = Buffer.alloc(1024);
    tar.write('toc.dat', 0);
    tar.write('ustar', 257);
    expect(detectPgDumpFormat(new Uint8Array(tar))).toBe('tar');
  });

  it('refuses plain SQL with a hint to use -Fc', () => {
    expect(code(() => detectPgDumpFormat(bytes('--\n-- PostgreSQL database dump\n--\nSET statement_timeout = 0;')))).toBe(
      'PLAIN_SQL',
    );
  });

  it('refuses empty, oversized and unknown files', () => {
    expect(code(() => detectPgDumpFormat(new Uint8Array()))).toBe('EMPTY');
    expect(code(() => detectPgDumpFormat(new Uint8Array(MAX_IMPORT_BYTES + 1)))).toBe('TOO_LARGE');
    expect(code(() => detectPgDumpFormat(bytes('\x89PNG\r\n\x1a\n')))).toBe('NOT_A_DUMP');
  });
});

describe('buildPgRestoreCommand', () => {
  it('restores all-or-nothing and cleans up the file whatever happens', () => {
    const cmd = buildPgRestoreCommand('pushify-db-main', 'user_main', 'main', '/opt/pushify/databases/main/imports/j1.dump');
    expect(cmd).toContain('--single-transaction');
    expect(cmd).toContain('--exit-on-error');
    expect(cmd).toContain('--no-owner --no-privileges');
    expect(cmd).not.toContain('--clean');
    expect(cmd).toContain("docker cp '/opt/pushify/databases/main/imports/j1.dump' 'pushify-db-main':'/tmp/j1.dump'");
    expect(cmd).toMatch(/rc=\$\?; docker exec 'pushify-db-main' rm -f '\/tmp\/j1.dump'; rm -f '\/opt\/pushify\/databases\/main\/imports\/j1.dump'; exit \$rc$/);
  });

  it('adds --clean --if-exists only when asked', () => {
    expect(buildPgRestoreCommand('c', 'u', 'd', '/x/j.dump', { clean: true })).toContain('--clean --if-exists');
  });

  it('quotes every value', () => {
    const cmd = buildPgRestoreCommand("c'; rm -rf /", 'u', 'd', '/x/j.dump');
    expect(cmd).toContain("'c'\\''; rm -rf /'");
  });
});

describe('appendLog', () => {
  it('keeps the tail when the log grows past the cap', () => {
    expect(appendLog('abc', 'def', 4)).toBe('cdef');
    expect(appendLog('a', 'b', 4)).toBe('ab');
  });
});

const job = (over: Partial<ImportJob> = {}): ImportJob => ({
  id: 'j1',
  databaseId: 'db-1',
  organizationId: 'org-1',
  status: 'uploading',
  fileName: 'x.dump',
  sizeBytes: 10,
  format: 'custom',
  clean: false,
  log: '',
  error: null,
  createdAt: new Date().toISOString(),
  finishedAt: null,
  ...over,
});

describe('createImportJobStore', () => {
  it('in memory: one running import per database, jobs readable until they expire', async () => {
    const store = createImportJobStore(null);
    expect(await store.acquire('db-1', 'j1')).toBe(true);
    expect(await store.acquire('db-1', 'j2')).toBe(false);
    expect(await store.acquire('db-2', 'j3')).toBe(true);

    await store.save(job({ status: 'restoring' }));
    expect((await store.get('j1'))?.status).toBe('restoring');
    expect(await store.get('nope')).toBeNull();

    await store.release('db-1');
    expect(await store.acquire('db-1', 'j4')).toBe(true);
  });

  it('in Redis: the lock is SET NX with an expiry', async () => {
    const kv = new Map<string, string>();
    const redis = {
      async set(key: string, value: string, _px: 'PX', _ms: number, nx?: 'NX') {
        if (nx === 'NX' && kv.has(key)) return null;
        kv.set(key, value);
        return 'OK';
      },
      async get(key: string) {
        return kv.get(key) ?? null;
      },
      async del(key: string) {
        return kv.delete(key) ? 1 : 0;
      },
    };
    const store = createImportJobStore(redis as ImportRedis);
    expect(await store.acquire('db-1', 'j1')).toBe(true);
    expect(await store.acquire('db-1', 'j2')).toBe(false);
    await store.save(job({ status: 'completed', log: 'done' }));
    expect(await store.get('j1')).toMatchObject({ status: 'completed', log: 'done' });
    await store.release('db-1');
    expect(await store.acquire('db-1', 'j2')).toBe(true);
  });
});
