import { describe, it, expect } from 'vitest';
import { isPlatformAdminEmail, parseAdminEmails } from './platform-admin';

describe('parseAdminEmails', () => {
  it('splits on commas and ignores whitespace and junk', () => {
    expect([...parseAdminEmails(' root@example.com , ops@example.com,,x, @ ')]).toEqual([
      'root@example.com',
      'ops@example.com',
    ]);
  });

  it('is empty when unset', () => {
    expect(parseAdminEmails('').size).toBe(0);
  });
});

describe('isPlatformAdminEmail', () => {
  it('matches case-insensitively', () => {
    expect(isPlatformAdminEmail('Root@Example.com', 'root@example.com')).toBe(true);
    expect(isPlatformAdminEmail('root@example.com', 'ROOT@EXAMPLE.COM')).toBe(true);
  });

  it('rejects everyone when the list is empty', () => {
    expect(isPlatformAdminEmail('root@example.com', '')).toBe(false);
    expect(isPlatformAdminEmail(null, 'root@example.com')).toBe(false);
  });

  it('does not match by prefix or domain', () => {
    expect(isPlatformAdminEmail('root@example.com.evil', 'root@example.com')).toBe(false);
    expect(isPlatformAdminEmail('other@example.com', 'root@example.com')).toBe(false);
  });
});
