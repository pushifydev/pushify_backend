import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  role: 'admin' as string | null,
  database: null as Record<string, unknown> | null,
  execCode: 0,
  execOutput: '',
  uploads: [] as string[],
  commands: [] as string[],
}));

vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => null }));
vi.mock('../lib/encryption', () => ({ decrypt: (v: string) => v }));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findMember: async () => (h.role ? { role: h.role } : null) },
}));
vi.mock('../repositories/database.repository', () => ({
  databaseRepository: { findById: async () => h.database },
}));
vi.mock('../db', () => ({
  db: { query: { servers: { findFirst: async () => ({ ipv4: '203.0.113.7', sshPrivateKey: 'key' }) } } },
}));
vi.mock('../utils/ssh', () => ({
  SSHClient: class {
    async connect() {}
    async mkdir() {}
    async uploadFile(_c: Buffer, path: string) {
      h.uploads.push(path);
    }
    async execStream(cmd: string, onStdout?: (d: string) => void) {
      h.commands.push(cmd);
      onStdout?.(h.execOutput);
      return h.execCode;
    }
    disconnect() {}
  },
}));

import { databaseImportService } from './database-import.service';

const dump = () => new Uint8Array(Buffer.from('PGDMP\x01\x0e\x00 archive body', 'latin1'));

async function finished(jobId: string) {
  for (let i = 0; i < 50; i++) {
    const job = await databaseImportService.getImport('db-1', jobId, 'org-1', 'user-1', 'en');
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('import did not finish');
}

async function status(p: Promise<unknown>): Promise<number | undefined> {
  try {
    await p;
  } catch (err) {
    return (err as { status?: number }).status;
  }
  return undefined;
}

describe('databaseImportService', () => {
  beforeEach(() => {
    h.role = 'admin';
    h.database = {
      id: 'db-1',
      organizationId: 'org-1',
      type: 'postgresql',
      status: 'running',
      serverId: 'srv-1',
      containerName: 'pushify-db-main',
      username: 'user_main',
      databaseName: 'main',
    };
    h.execCode = 0;
    h.execOutput = 'pg_restore: creating TABLE "public.users"\n';
    h.uploads = [];
    h.commands = [];
  });

  it('imports a pg_dump archive and reports progress and the pg_restore log', async () => {
    const job = await databaseImportService.startImport('db-1', 'org-1', 'user-1', { name: 'prod.dump', bytes: dump() }, {}, 'en');
    expect(job.status).toBe('uploading');

    const done = await finished(job.id);
    expect(done.status).toBe('completed');
    expect(done.error).toBeNull();
    expect(done.log).toContain('creating TABLE "public.users"');
    expect(done.finishedAt).not.toBeNull();
    expect(h.uploads).toEqual([`/opt/pushify/databases/main/imports/${job.id}.dump`]);
    expect(h.commands[0]).toContain('--single-transaction --exit-on-error');
  });

  it('a failing dump ends as failed with the log, and frees the database for the next import', async () => {
    h.execCode = 1;
    h.execOutput = 'pg_restore: error: could not execute query: ERROR:  relation "users" already exists\n';
    const job = await databaseImportService.startImport('db-1', 'org-1', 'user-1', { name: 'bad.dump', bytes: dump() }, {}, 'en');

    const done = await finished(job.id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatch(/rolled back/);
    expect(done.log).toContain('already exists');

    h.execCode = 0;
    const next = await databaseImportService.startImport('db-1', 'org-1', 'user-1', { name: 'ok.dump', bytes: dump() }, {}, 'en');
    expect((await finished(next.id)).status).toBe('completed');
  });

  it('refuses files that are not pg_dump archives before touching the server', async () => {
    const sql = new Uint8Array(Buffer.from('--\n-- PostgreSQL database dump\nSET x = 1;'));
    expect(await status(databaseImportService.startImport('db-1', 'org-1', 'user-1', { name: 'a.sql', bytes: sql }, {}, 'en'))).toBe(400);
    expect(h.uploads).toEqual([]);
  });

  it('is limited to owners and admins', async () => {
    for (const role of ['member', 'viewer', null]) {
      h.role = role;
      expect(await status(databaseImportService.startImport('db-1', 'org-1', 'user-1', { name: 'x.dump', bytes: dump() }, {}, 'en'))).toBe(403);
    }
    expect(h.uploads).toEqual([]);
  });

  it('only PostgreSQL databases of the caller organization', async () => {
    h.database = { ...h.database!, type: 'mysql' };
    expect(await status(databaseImportService.startImport('db-1', 'org-1', 'user-1', { name: 'x.dump', bytes: dump() }, {}, 'en'))).toBe(400);
    h.database = { ...h.database!, type: 'postgresql', organizationId: 'org-2' };
    expect(await status(databaseImportService.startImport('db-1', 'org-1', 'user-1', { name: 'x.dump', bytes: dump() }, {}, 'en'))).toBe(404);
  });

  it('does not show another database’s import', async () => {
    const job = await databaseImportService.startImport('db-1', 'org-1', 'user-1', { name: 'x.dump', bytes: dump() }, {}, 'en');
    await finished(job.id);
    expect(await status(databaseImportService.getImport('db-2', job.id, 'org-1', 'user-1', 'en'))).toBe(404);
  });
});
