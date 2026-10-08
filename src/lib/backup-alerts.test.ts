import { describe, it, expect } from 'vitest';
import {
  BACKUP_EVENTS,
  completedBackupEvent,
  isBackupOverdue,
  isBackupStuck,
} from './backup-alerts';

const now = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));
const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000);

describe('completedBackupEvent', () => {
  it('is a success when the off-site copy made it or is not configured', () => {
    expect(completedBackupEvent('uploaded')).toBe(BACKUP_EVENTS.success);
    expect(completedBackupEvent('skipped')).toBe(BACKUP_EVENTS.success);
    expect(completedBackupEvent(null)).toBe(BACKUP_EVENTS.success);
  });

  it('is a warning when the dump only exists on the database server', () => {
    expect(completedBackupEvent('failed')).toBe(BACKUP_EVENTS.warning);
  });
});

describe('isBackupStuck', () => {
  it('leaves a running backup alone', () => {
    expect(isBackupStuck(hoursAgo(0.5), now)).toBe(false);
  });

  it('gives up on one that has been creating for hours', () => {
    expect(isBackupStuck(hoursAgo(2), now)).toBe(true);
    expect(isBackupStuck(hoursAgo(30), now)).toBe(true);
  });
});

describe('isBackupOverdue', () => {
  it('is not overdue within one extra interval', () => {
    expect(isBackupOverdue(hoursAgo(30), hoursAgo(1000), 24, now)).toBe(false);
    expect(isBackupOverdue(hoursAgo(1.5), hoursAgo(1000), 1, now)).toBe(false);
  });

  it('is overdue once two intervals pass without a backup', () => {
    expect(isBackupOverdue(hoursAgo(48), hoursAgo(1000), 24, now)).toBe(true);
    expect(isBackupOverdue(hoursAgo(13), hoursAgo(1000), 6, now)).toBe(true);
  });

  it('measures a never-backed-up database from its creation', () => {
    expect(isBackupOverdue(null, hoursAgo(5), 24, now)).toBe(false);
    expect(isBackupOverdue(null, hoursAgo(50), 24, now)).toBe(true);
  });

  it('falls back to a daily interval', () => {
    expect(isBackupOverdue(hoursAgo(47), hoursAgo(1000), null, now)).toBe(false);
    expect(isBackupOverdue(hoursAgo(48), hoursAgo(1000), 0, now)).toBe(true);
  });
});
