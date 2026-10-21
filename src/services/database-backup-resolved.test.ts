import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  databases: [] as Array<Record<string, unknown>>,
  rows: [] as Array<Record<string, unknown>>,
  notifications: [] as Array<{ projectId: string; event: string; message: string }>,
}));

vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => null }));
vi.mock('../db', () => ({ db: {} }));
vi.mock('../repositories/organization.repository', () => ({ organizationRepository: {} }));
vi.mock('../repositories/database.repository', () => {
  const since = (status: string) => (databaseId: string, from: Date, excludeId?: string) =>
    h.rows.find(
      (r) =>
        r.databaseId === databaseId &&
        r.status === status &&
        (r.startedAt as Date) >= from &&
        r.id !== excludeId
    );
  return {
    databaseRepository: {
      findById: async (id: string) => h.databases.find((d) => d.id === id),
      findConnectionsByDatabase: async () => [{ projectId: 'proj-1' }],
      findFailedBackupSince: since('failed'),
      findMissedBackupSince: since('missed'),
    },
  };
});
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

// The service remembers reported failures per database id, so each test uses its own id
let seq = 0;
let dbId = '';
function row(id: string, status: string, startedAt: Date) {
  h.rows.push({ id, databaseId: dbId, status, startedAt });
}
/** What executeBackup does after a successful dump: resolve, then move `lastBackupAt`. */
async function succeed(id: string, at: Date) {
  row(id, 'completed', at);
  const sent = await databaseBackupService.notifyBackupResolved(dbId, `${id} completed`, id);
  h.databases[0].lastBackupAt = at;
  return sent;
}
const events = () => h.notifications.map((n) => n.event);

beforeEach(() => {
  dbId = `db-r-${++seq}`;
  h.rows = [];
  h.notifications = [];
  h.databases = [{ id: dbId, name: 'main', lastBackupAt: hoursAgo(30), createdAt: hoursAgo(1000) }];
});

describe('notifyBackupResolved', () => {
  it('sends one backup.resolved for the first success after a failed backup', async () => {
    row('b1', 'failed', hoursAgo(5));

    const sent = await succeed('b2', hoursAgo(1));

    expect(sent).toBe(true);
    expect(h.notifications).toEqual([
      expect.objectContaining({ projectId: 'proj-1', event: 'backup.resolved' }),
    ]);
    expect(h.notifications[0].message).toContain('b2 completed');
  });

  it('sends one backup.resolved for the first success after a missed backup', async () => {
    h.databases[0].lastBackupAt = hoursAgo(80);
    row('m1', 'missed', hoursAgo(30));

    const sent = await succeed('b1', hoursAgo(1));

    expect(sent).toBe(true);
    expect(events()).toEqual(['backup.resolved']);
  });

  it('sends nothing for an ordinary success', async () => {
    // A failure before the last successful backup was already resolved by it
    row('old', 'failed', hoursAgo(40));

    const sent = await succeed('b1', hoursAgo(1));

    expect(sent).toBe(false);
    expect(h.notifications).toHaveLength(0);
  });

  it('one incident: one failure alert, one resolved message, then silence', async () => {
    row('b1', 'failed', hoursAgo(6));
    await databaseBackupService.notifyBackupFailure(dbId, 'b1 failed', 'b1');
    row('b2', 'failed', hoursAgo(5));
    await databaseBackupService.notifyBackupFailure(dbId, 'b2 failed', 'b2');
    row('b3', 'failed', hoursAgo(4));
    await databaseBackupService.notifyBackupFailure(dbId, 'b3 failed', 'b3');

    await succeed('b4', hoursAgo(3));
    await succeed('b5', hoursAgo(2));
    await succeed('b6', hoursAgo(1));

    expect(events()).toEqual(['backup.failed', 'backup.resolved']);
  });

  it('resolves a backup that could not start (no failed row)', async () => {
    await databaseBackupService.notifyBackupFailure(dbId, 'could not start');

    const sent = await succeed('b1', hoursAgo(1));

    expect(sent).toBe(true);
    expect(events()).toEqual(['backup.failed', 'backup.resolved']);
  });

  it('reports a new incident after it was resolved', async () => {
    row('b1', 'failed', hoursAgo(6));
    await databaseBackupService.notifyBackupFailure(dbId, 'b1 failed', 'b1');
    await succeed('b2', hoursAgo(5));

    row('b3', 'failed', hoursAgo(3));
    await databaseBackupService.notifyBackupFailure(dbId, 'b3 failed', 'b3');
    await succeed('b4', hoursAgo(1));

    expect(events()).toEqual(['backup.failed', 'backup.resolved', 'backup.failed', 'backup.resolved']);
  });
});
