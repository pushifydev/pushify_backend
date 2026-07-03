import { describe, it, expect } from 'vitest';
import { validateCronExpression, nextCronRun, isValidTimezone } from './cron-schedule';

describe('validateCronExpression', () => {
  it('accepts common 5-field expressions', () => {
    expect(validateCronExpression('*/5 * * * *')).toBeNull();
    expect(validateCronExpression('0 3 * * *')).toBeNull();
    expect(validateCronExpression('30 2 * * 1-5')).toBeNull();
    expect(validateCronExpression('0 0 1 * *')).toBeNull();
  });

  it('rejects the wrong number of fields', () => {
    expect(validateCronExpression('* * * *')).toMatch(/5-field/);
    expect(validateCronExpression('* * * * * *')).toMatch(/5-field/);
    expect(validateCronExpression('')).toMatch(/5-field/);
  });

  it('rejects out-of-range values', () => {
    expect(validateCronExpression('99 * * * *')).not.toBeNull();
    expect(validateCronExpression('* 25 * * *')).not.toBeNull();
  });

  it('rejects an invalid timezone', () => {
    expect(validateCronExpression('*/5 * * * *', 'Not/AZone')).toMatch(/timezone/i);
    expect(validateCronExpression('*/5 * * * *', 'Europe/Istanbul')).toBeNull();
  });
});

describe('nextCronRun', () => {
  it('computes the next occurrence after a reference time', () => {
    const from = new Date('2026-07-03T10:20:00Z');
    const next = nextCronRun('0 * * * *', 'UTC', from);
    expect(next?.toISOString()).toBe('2026-07-03T11:00:00.000Z');
  });

  it('respects the timezone', () => {
    const from = new Date('2026-07-03T10:20:00Z');
    // 03:00 daily in Istanbul (UTC+3) → next fire is 00:00 UTC the next day
    const next = nextCronRun('0 3 * * *', 'Europe/Istanbul', from);
    expect(next?.toISOString()).toBe('2026-07-04T00:00:00.000Z');
  });

  it('always returns a strictly later time', () => {
    const from = new Date('2026-07-03T10:00:00Z');
    const next = nextCronRun('0 10 * * *', 'UTC', from);
    expect(next!.getTime()).toBeGreaterThan(from.getTime());
  });
});

describe('isValidTimezone', () => {
  it('accepts IANA names and rejects junk', () => {
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('Europe/Istanbul')).toBe(true);
    expect(isValidTimezone('Mars/Olympus')).toBe(false);
  });
});
