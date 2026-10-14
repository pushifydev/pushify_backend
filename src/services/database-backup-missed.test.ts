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
    findDatabasesWithBackupEnabled: async () => h.databases,
    findById: async (id: string) => h.databases.find((d) => d.id === id),
    findConnectionsByDatabase: async () => [{ projectId: 'proj-1' }],
    findMissedBackupSince: async (databaseId: string, since: Date) =>
      h.rows.find(
        (r) => r.databaseId === databaseId && r.status === 'missed' && (r.startedAt as Date) >= since
      ),
    createBackup: async (data: Record<string, unknown>) => {
      const row = { id: `row-${h.rows.length + 1}`, ...data };
      h.rows.push(row);
      return row;
    },
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
const hoursAgo = (h: number, from = now) => new Date(from.getTime() - h * 3600_000);

beforeEach(() => {
  h.rows = [];
  h.notifications = [];
  h.databases = [
    {
      id: 'db-1',
      name: 'main',
      lastBackupAt: hoursAgo(72),
      createdAt: hoursAgo(1000),
      backupIntervalHours: 24,
    },
  ];
});

describe('alertMissedBackups', () => {
  it('records a missed backup row and notifies once', async () => {
    const sent = await databaseBackupService.alertMissedBackups(new Map(), now);

    expect(sent).toBe(1);
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ databaseId: 'db-1', status: 'missed', startedAt: now });
    expect(h.rows[0].errorMessage).toContain('No successful backup');
    expect(h.notifications).toEqual([
      expect.objectContaining({ projectId: 'proj-1', event: 'backup.missed' }),
    ]);
  });

  it('does not repeat the alert for the same gap, even after a worker restart', async () => {
    await databaseBackupService.alertMissedBackups(new Map(), now);
    // Fresh in-memory map = the worker restarted; the persisted row still suppresses it
    const sent = await databaseBackupService.alertMissedBackups(new Map(), hoursAgo(-1));

    expect(sent).toBe(0);
    expect(h.rows).toHaveLength(1);
    expect(h.notifications).toHaveLength(1);
  });

  it('alerts again for a new gap after a successful backup', async () => {
    await databaseBackupService.alertMissedBackups(new Map(), now);
    h.databases[0].lastBackupAt = hoursAgo(-1);

    const later = hoursAgo(-60);
    const sent = await databaseBackupService.alertMissedBackups(new Map(), later);

    expect(sent).toBe(1);
    expect(h.rows.filter((r) => r.status === 'missed')).toHaveLength(2);
    expect(h.notifications).toHaveLength(2);
  });

  it('records nothing while backups are on schedule', async () => {
    h.databases[0].lastBackupAt = hoursAgo(10);

    const sent = await databaseBackupService.alertMissedBackups(new Map(), now);

    expect(sent).toBe(0);
    expect(h.rows).toHaveLength(0);
    expect(h.notifications).toHaveLength(0);
  });
});
