import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  databases: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<{ projectId: string; event: string; message: string }>,
}));

vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => null }));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: {} }));
vi.mock('../repositories/database.repository', () => ({
  databaseRepository: {
    findById: async (id: string) => h.databases.find((d) => d.id === id),
    findConnectionsByDatabase: async () => [{ projectId: 'proj-1' }],
    findFailedBackupSince: async (databaseId: string, since: Date, excludeId?: string) =>
      h.rows.find(
        (r) =>
          r.databaseId === databaseId &&
          r.status === 'failed' &&
          (r.startedAt as Date) >= since &&
          r.id !== excludeId
      ),
  },
}));
vi.mock('./notification.service', () => ({
  notificationService: {
    sendNotifications: async (projectId: string, event: string, payload: { message: string }) => {
      h.notifications.push({ projectId, event, message: payload.message });
    },
  },
}));

import { databaseBackupService } from './database-backup.service';

const now = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3600_000);

// The service remembers reported runs per database id, so each test uses its own id
let seq = 0;
let dbId = '';
function fail(id: string, startedAt: Date) {
  h.rows.push({ id, databaseId: dbId, status: 'failed', startedAt });
}

beforeEach(() => {
  dbId = `db-${++seq}`;
  h.rows = [];
  h.notifications = [];
  h.databases = [{ id: dbId, name: 'main', lastBackupAt: hoursAgo(30), createdAt: hoursAgo(1000) }];
});

describe('notifyBackupFailure', () => {
  it('sends one backup.failed notification for a failed backup', async () => {
    fail('b1', hoursAgo(1));

    const sent = await databaseBackupService.notifyBackupFailure(dbId, 'Backup b1 failed: boom', 'b1');

    expect(sent).toBe(true);
    expect(h.notifications).toEqual([
      expect.objectContaining({ projectId: 'proj-1', event: 'backup.failed' }),
    ]);
    expect(h.notifications[0].message).toContain('Backup b1 failed: boom');
  });

  it('does not repeat while the same failures keep happening', async () => {
    fail('b1', hoursAgo(2));
    await databaseBackupService.notifyBackupFailure(dbId, 'Backup b1 failed', 'b1');
    fail('b2', hoursAgo(1));
    const second = await databaseBackupService.notifyBackupFailure(dbId, 'Backup b2 failed', 'b2');
    const couldNotStart = await databaseBackupService.notifyBackupFailure(dbId, 'could not start');

    expect(second).toBe(false);
    expect(couldNotStart).toBe(false);
    expect(h.notifications).toHaveLength(1);
  });

  it('does not repeat after a worker restart: an earlier failed row suppresses it', async () => {
    // b1 failed and was reported before the restart; the in-memory marker for this id is unset
    fail('b1', hoursAgo(2));
    fail('b2', hoursAgo(1));

    const sent = await databaseBackupService.notifyBackupFailure(dbId, 'Backup b2 failed', 'b2');

    expect(sent).toBe(false);
    expect(h.notifications).toHaveLength(0);
  });

  it('reports a backup that could not start only once', async () => {
    await databaseBackupService.notifyBackupFailure(dbId, 'could not start');
    await databaseBackupService.notifyBackupFailure(dbId, 'could not start');

    expect(h.notifications).toHaveLength(1);
  });

  it('reports again after a successful backup', async () => {
    fail('b1', hoursAgo(2));
    await databaseBackupService.notifyBackupFailure(dbId, 'Backup b1 failed', 'b1');

    h.databases[0].lastBackupAt = hoursAgo(1); // a backup succeeded
    fail('b2', hoursAgo(0.5));
    const sent = await databaseBackupService.notifyBackupFailure(dbId, 'Backup b2 failed', 'b2');

    expect(sent).toBe(true);
    expect(h.notifications).toHaveLength(2);
  });
});
