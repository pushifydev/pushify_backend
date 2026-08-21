import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * The studio can read, edit and delete a customer's data. The only thing standing between a
 * request and that data is the gate in `openStudioSession`: organisation membership, the
 * owner/admin role, the engine, and the container's state.
 *
 * These tests exercise that gate with the repositories and the SSH transport mocked, so a
 * regression in the checks fails here instead of in production.
 */
const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const USER = 'user-1';

const mocks = vi.hoisted(() => ({
  findMember: vi.fn(),
  findDatabase: vi.fn(),
  findServer: vi.fn(),
  exec: vi.fn(),
  log: vi.fn(),
}));

vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findMember: mocks.findMember },
}));

vi.mock('../repositories/database.repository', () => ({
  databaseRepository: { findById: mocks.findDatabase },
}));

vi.mock('../db', () => ({
  db: { query: { servers: { findFirst: mocks.findServer } } },
}));

vi.mock('../utils/ssh', () => ({
  getSSHConnection: vi.fn(async () => ({
    isConnected: () => true,
    exec: mocks.exec,
  })),
}));

// The encryption key is irrelevant to access control; keep the fixtures readable.
vi.mock('../lib/encryption', () => ({
  decrypt: (value: string) => value,
  encrypt: (value: string) => value,
}));

vi.mock('./activity.service', () => ({
  activityService: { log: mocks.log },
}));

import { databaseStudioService } from './database-studio.service';
import { nosqlStudioService } from './nosql-studio.service';

const database = (overrides: Record<string, unknown> = {}) => ({
  id: 'db-1',
  organizationId: ORG,
  serverId: 'server-1',
  containerName: 'pushify-db-app',
  username: 'app_user',
  databaseName: 'app',
  password: 'secret',
  name: 'App DB',
  type: 'postgresql',
  status: 'running',
  ...overrides,
});

const server = () => ({ id: 'server-1', ipv4: '10.0.0.1', sshPrivateKey: 'key' });

/** psql answers our catalog query with a JSON array; enough for the happy path. */
const ok = (stdout: string) => ({ stdout, stderr: '', code: 0 });

async function status(run: () => Promise<unknown>): Promise<number | string> {
  try {
    await run();
    return 'resolved';
  } catch (error) {
    return error instanceof HTTPException ? error.status : `threw ${String(error)}`;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMember.mockResolvedValue({ role: 'owner' });
  mocks.findDatabase.mockResolvedValue(database());
  mocks.findServer.mockResolvedValue(server());
  mocks.exec.mockResolvedValue(ok('[]'));
  mocks.log.mockResolvedValue(undefined);
});

describe('studio access control', () => {
  it('lets an owner in', async () => {
    mocks.exec.mockResolvedValue(ok('[]'));
    await expect(databaseStudioService.listTables('db-1', ORG, USER, 'en')).resolves.toEqual(
      expect.objectContaining({ engine: 'postgresql' })
    );
  });

  it('lets an admin in', async () => {
    mocks.findMember.mockResolvedValue({ role: 'admin' });
    expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(
      'resolved'
    );
  });

  it('refuses a member and a viewer who were granted nothing', async () => {
    for (const role of ['member', 'viewer']) {
      mocks.findMember.mockResolvedValue({ role, studioAccess: 'none' });
      expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(403);
    }
  });

  it('defaults to no access when the column has not been set', async () => {
    mocks.findMember.mockResolvedValue({ role: 'member' });
    expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(403);
  });

  it('refuses someone who is not in the organisation at all', async () => {
    mocks.findMember.mockResolvedValue(null);
    expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(403);
  });

  it('hides a database that belongs to another organisation behind a 404', async () => {
    mocks.findDatabase.mockResolvedValue(database({ organizationId: OTHER_ORG }));
    // 404 rather than 403: a wrong-org id must not be distinguishable from a missing one.
    expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(404);
  });

  it('404s a database that does not exist', async () => {
    mocks.findDatabase.mockResolvedValue(null);
    expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(404);
  });

  it('refuses an engine this studio does not speak', async () => {
    mocks.findDatabase.mockResolvedValue(database({ type: 'redis' }));
    expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(400);
  });

  it('refuses a database that is not running', async () => {
    for (const state of ['stopped', 'provisioning', 'error', 'deleting']) {
      mocks.findDatabase.mockResolvedValue(database({ status: state }));
      expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(400);
    }
  });

  it('refuses a database whose container is unknown', async () => {
    mocks.findDatabase.mockResolvedValue(database({ containerName: null }));
    expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(400);
  });

  it('refuses when the server has no usable SSH credentials', async () => {
    mocks.findServer.mockResolvedValue({ id: 'server-1', ipv4: null, sshPrivateKey: null });
    expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(400);
  });

  it('applies the same gate to writes', async () => {
    mocks.findMember.mockResolvedValue({ role: 'member', studioAccess: 'none' });

    const writes = [
      () => databaseStudioService.getRows('db-1', ORG, USER, { table: 'users' }, 'en'),
      () =>
        databaseStudioService.insertRow('db-1', ORG, USER, { table: 'users', values: { a: 1 } }, 'en'),
      () =>
        databaseStudioService.deleteRows('db-1', ORG, USER, { table: 'users', pks: [{ id: 1 }] }, 'en'),
      () => databaseStudioService.dropTable('db-1', ORG, USER, { table: 'users' }, 'en'),
      () =>
        databaseStudioService.createTable(
          'db-1',
          ORG,
          USER,
          { name: 'x', columns: [{ name: 'a', type: 'text' }] },
          'en'
        ),
      () => databaseStudioService.runQuery('db-1', ORG, USER, { sql: 'SELECT 1' }, 'en'),
      () => databaseStudioService.exportQuery('db-1', ORG, USER, { sql: 'SELECT 1' }, 'en'),
      () => databaseStudioService.getPerformance('db-1', ORG, USER, 'en'),
      () => databaseStudioService.importRows('db-1', ORG, USER, { table: 'u', columns: ['a'], rows: [['1']] }, 'en'),
    ];

    for (const write of writes) {
      expect(await status(write)).toBe(403);
    }
  });

  it('never reaches the server when the gate rejects', async () => {
    mocks.findMember.mockResolvedValue({ role: 'member', studioAccess: 'none' });
    await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'));
    expect(mocks.exec).not.toHaveBeenCalled();
  });
});

describe('granted data-browser access', () => {
  it('lets a read-granted member browse', async () => {
    mocks.findMember.mockResolvedValue({ role: 'member', studioAccess: 'read' });
    mocks.exec.mockResolvedValue(ok('[]'));

    expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(
      'resolved'
    );
  });

  it('stops a read-granted member at every write', async () => {
    mocks.findMember.mockResolvedValue({ role: 'member', studioAccess: 'read' });

    const writes = [
      () => databaseStudioService.insertRow('db-1', ORG, USER, { table: 'u', values: { a: 1 } }, 'en'),
      () => databaseStudioService.updateRow('db-1', ORG, USER, { table: 'u', values: { a: 1 }, pk: { id: 1 } }, 'en'),
      () => databaseStudioService.deleteRows('db-1', ORG, USER, { table: 'u', pks: [{ id: 1 }] }, 'en'),
      () => databaseStudioService.dropTable('db-1', ORG, USER, { table: 'u' }, 'en'),
      () => databaseStudioService.truncateTable('db-1', ORG, USER, { table: 'u' }, 'en'),
      () => databaseStudioService.createIndex('db-1', ORG, USER, { table: 'u', columns: ['a'] }, 'en'),
      () => databaseStudioService.importRows('db-1', ORG, USER, { table: 'u', columns: ['a'], rows: [['1']] }, 'en'),
      () => databaseStudioService.cancelQuery('db-1', ORG, USER, 42, 'en'),
    ];

    for (const write of writes) {
      expect(await status(write)).toBe(403);
    }
  });

  it('lets a read-granted member run a read-only query but not a write one', async () => {
    mocks.findMember.mockResolvedValue({ role: 'member', studioAccess: 'read' });
    mocks.exec.mockResolvedValue(ok('[]'));

    expect(
      await status(() => databaseStudioService.runQuery('db-1', ORG, USER, { sql: 'SELECT 1' }, 'en'))
    ).toBe('resolved');

    // Write mode is a different permission, even for the same statement.
    expect(
      await status(() =>
        databaseStudioService.runQuery('db-1', ORG, USER, { sql: 'DELETE FROM u', allowWrite: true }, 'en')
      )
    ).toBe(403);
  });

  it('lets a write-granted member write', async () => {
    mocks.findMember.mockResolvedValue({ role: 'member', studioAccess: 'write' });
    mocks.exec.mockResolvedValue(ok('[]'));

    expect(await status(() => databaseStudioService.listTables('db-1', ORG, USER, 'en'))).toBe(
      'resolved'
    );
  });

  it('applies the same grant to the mongo and redis studios', async () => {
    mocks.findDatabase.mockResolvedValue(database({ type: 'mongodb' }));
    mocks.findMember.mockResolvedValue({ role: 'member', studioAccess: 'read' });
    mocks.exec.mockResolvedValue(ok('{"ok":true,"data":[]}'));

    expect(await status(() => nosqlStudioService.listCollections('db-1', ORG, USER, 'en'))).toBe(
      'resolved'
    );
    expect(
      await status(() =>
        nosqlStudioService.insertDocument('db-1', ORG, USER, { collection: 'c', document: '{"a":1}' }, 'en')
      )
    ).toBe(403);
  });
});

describe('nosql studio access control', () => {
  it('refuses a member', async () => {
    mocks.findDatabase.mockResolvedValue(database({ type: 'mongodb' }));
    mocks.findMember.mockResolvedValue({ role: 'member', studioAccess: 'none' });
    expect(await status(() => nosqlStudioService.listCollections('db-1', ORG, USER, 'en'))).toBe(403);
  });

  it('keeps the engines apart in both directions', async () => {
    // A SQL database is not browsable through the mongo studio…
    mocks.findDatabase.mockResolvedValue(database({ type: 'postgresql' }));
    expect(await status(() => nosqlStudioService.listCollections('db-1', ORG, USER, 'en'))).toBe(400);

    // …and a mongo database is not browsable through the redis studio.
    mocks.findDatabase.mockResolvedValue(database({ type: 'mongodb' }));
    expect(await status(() => nosqlStudioService.scanKeys('db-1', ORG, USER, {}, 'en'))).toBe(400);
  });

  it('hides another organisation-s database behind a 404', async () => {
    mocks.findDatabase.mockResolvedValue(database({ type: 'redis', organizationId: OTHER_ORG }));
    expect(await status(() => nosqlStudioService.scanKeys('db-1', ORG, USER, {}, 'en'))).toBe(404);
  });
});

describe('read-only console mode', () => {
  // These are refused before a session is even opened, so they need no transport at all.
  it('allows a single read statement', async () => {
    mocks.exec.mockResolvedValue(ok('[]'));
    expect(
      await status(() => databaseStudioService.runQuery('db-1', ORG, USER, { sql: 'SELECT 1' }, 'en'))
    ).toBe('resolved');
  });

  it('refuses a write statement', async () => {
    for (const sql of ['DELETE FROM users', 'UPDATE users SET a = 1', 'DROP TABLE users']) {
      expect(await status(() => databaseStudioService.runQuery('db-1', ORG, USER, { sql }, 'en'))).toBe(
        400
      );
    }
  });

  it('refuses a chained statement that would escape the read-only transaction', async () => {
    expect(
      await status(() =>
        databaseStudioService.runQuery(
          'db-1',
          ORG,
          USER,
          { sql: 'SELECT 1; COMMIT; DROP TABLE users' },
          'en'
        )
      )
    ).toBe(400);
  });

  it('refuses an empty or oversized query', async () => {
    expect(await status(() => databaseStudioService.runQuery('db-1', ORG, USER, { sql: '  ' }, 'en'))).toBe(
      400
    );
    expect(
      await status(() =>
        databaseStudioService.runQuery('db-1', ORG, USER, { sql: `SELECT '${'x'.repeat(20_001)}'` }, 'en')
      )
    ).toBe(400);
  });

  it('exports only ever run read-only', async () => {
    mocks.exec.mockResolvedValue(ok('[]'));
    expect(
      await status(() =>
        databaseStudioService.exportQuery('db-1', ORG, USER, { sql: 'DELETE FROM users' }, 'en')
      )
    ).toBe(400);
  });
});
