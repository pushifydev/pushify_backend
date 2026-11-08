import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  deleted: [] as string[],
  commands: [] as string[],
}));

vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => null }));
vi.mock('../lib/encryption', () => ({ decrypt: (v: string) => v }));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: {} }));
vi.mock('../repositories/database.repository', () => ({
  databaseRepository: {
    findExpiredBackups: async () =>
      h.rows.filter((r) => r.status === 'completed' && (r.expiresAt as Date) <= new Date()),
    findLatestFinishedBackup: async (databaseId: string) =>
      h.rows
        .filter((r) => r.databaseId === databaseId && ['completed', 'restored'].includes(r.status as string))
        .sort((a, b) => (b.startedAt as Date).getTime() - (a.startedAt as Date).getTime())[0],
    findById: async (id: string) => ({ id, serverId: 'srv-1' }),
    deleteBackup: async (id: string) => {
      h.deleted.push(id);
      h.rows = h.rows.filter((r) => r.id !== id);
    },
  },
}));
vi.mock('../db', () => ({
  db: { query: { servers: { findFirst: async () => ({ ipv4: '203.0.113.7', sshPrivateKey: 'key' }) } } },
}));
vi.mock('../utils/ssh', () => ({
  SSHClient: class {
    async connect() {}
    async exec(cmd: string) {
      h.commands.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    }
    disconnect() {}
  },
}));

import { databaseBackupService } from './database-backup.service';

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 3600_000);

/** A backup taken `ageDays` ago with the default 7-day retention */
function backup(id: string, databaseId: string, ageDays: number, status = 'completed') {
  h.rows.push({
    id,
    databaseId,
    status,
    filePath: `/opt/pushify/databases/${databaseId}/backups/${id}.sql.gz`,
    startedAt: daysAgo(ageDays),
    expiresAt: daysAgo(ageDays - 7),
  });
}

beforeEach(() => {
  h.rows = [];
  h.deleted = [];
  h.commands = [];
});

describe('cleanupExpiredBackups', () => {
  it('keeps the only backup of a database even when it has expired', async () => {
    backup('only', 'db-1', 30);

    await databaseBackupService.cleanupExpiredBackups();

    expect(h.deleted).toEqual([]);
    expect(h.commands).toEqual([]);
    expect(h.rows.map((r) => r.id)).toEqual(['only']);
  });

  it('deletes an expired backup once a newer completed backup exists', async () => {
    backup('old', 'db-1', 10);
    backup('new', 'db-1', 1);

    await databaseBackupService.cleanupExpiredBackups();

    expect(h.deleted).toEqual(['old']);
    expect(h.commands).toEqual(['rm -f /opt/pushify/databases/db-1/backups/old.sql.gz']);
    expect(h.rows.map((r) => r.id)).toEqual(['new']);
  });

  it('keeps the newest backup when every backup has expired (backups failing or turned off)', async () => {
    backup('oldest', 'db-1', 30);
    backup('older', 'db-1', 20);
    backup('newest', 'db-1', 10);
    // Backups have been failing since — a failed run is nothing to restore from
    backup('broken', 'db-1', 2, 'failed');

    await databaseBackupService.cleanupExpiredBackups();

    expect(h.deleted.sort()).toEqual(['older', 'oldest']);
    expect(h.rows.map((r) => r.id).sort()).toEqual(['broken', 'newest']);
  });

  it('decides per database', async () => {
    backup('a-old', 'db-a', 10);
    backup('a-new', 'db-a', 1);
    backup('b-only', 'db-b', 10);

    await databaseBackupService.cleanupExpiredBackups();

    expect(h.deleted).toEqual(['a-old']);
    expect(h.rows.map((r) => r.id).sort()).toEqual(['a-new', 'b-only']);
  });
});
