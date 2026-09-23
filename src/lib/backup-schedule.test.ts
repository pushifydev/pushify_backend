import { describe, it, expect } from 'vitest';
import { isBackupDue, resolveBackupInterval, worstCaseDataLoss } from './backup-schedule';

const at = (hoursAgo: number) => new Date(Date.UTC(2026, 8, 23, 12, 0, 0) - hoursAgo * 3600_000);
const now = new Date(Date.UTC(2026, 8, 23, 12, 0, 0));

describe('resolveBackupInterval', () => {
  const paid = { minBackupIntervalHours: 6 };

  it('accepts an interval at or above the plan floor', () => {
    expect(resolveBackupInterval(6, paid)).toEqual({ hours: 6 });
    expect(resolveBackupInterval(24, paid)).toEqual({ hours: 24 });
  });

  it('refuses one below it, and says what to do about it', () => {
    const result = resolveBackupInterval(1, paid);
    expect('error' in result && result.error).toMatch(/every 6 hours/);
    expect('error' in result && result.error).toMatch(/Upgrade/);
  });

  it('refuses nonsense whatever the plan allows', () => {
    const unlimited = { minBackupIntervalHours: 1 };
    expect('error' in resolveBackupInterval(0, unlimited)).toBe(true);
    expect('error' in resolveBackupInterval(-5, unlimited)).toBe(true);
    expect('error' in resolveBackupInterval(200, unlimited)).toBe(true);
    expect('error' in resolveBackupInterval(NaN, unlimited)).toBe(true);
  });

  it('rounds rather than rejecting a fractional hour', () => {
    expect(resolveBackupInterval(6.4, paid)).toEqual({ hours: 6 });
  });
});

describe('isBackupDue', () => {
  it('is due immediately when there has never been a backup', () => {
    // The window with nothing to restore from is the one that matters most
    expect(isBackupDue(null, 24, now)).toBe(true);
    expect(isBackupDue(undefined, 1, now)).toBe(true);
  });

  it('waits out the interval', () => {
    expect(isBackupDue(at(23), 24, now)).toBe(false);
    expect(isBackupDue(at(24), 24, now)).toBe(true);
    expect(isBackupDue(at(25), 24, now)).toBe(true);
  });

  it('honours a short interval', () => {
    expect(isBackupDue(at(0.5), 1, now)).toBe(false);
    expect(isBackupDue(at(1), 1, now)).toBe(true);
  });

  it('falls back to a day when the interval is missing, never to zero', () => {
    expect(isBackupDue(at(23), null, now)).toBe(false);
    expect(isBackupDue(at(25), null, now)).toBe(true);
    // A stored 0 would otherwise mean "back up on every pass, for ever"
    expect(isBackupDue(at(0.5), 0, now)).toBe(false);
  });
});

describe('worstCaseDataLoss', () => {
  it('says what the interval costs, in words a customer understands', () => {
    expect(worstCaseDataLoss(1)).toBe('up to 1 hour');
    expect(worstCaseDataLoss(6)).toBe('up to 6 hours');
    expect(worstCaseDataLoss(24)).toBe('up to 1 day');
    expect(worstCaseDataLoss(72)).toBe('up to 3 days');
    expect(worstCaseDataLoss(null)).toBe('up to 1 day');
  });
});
