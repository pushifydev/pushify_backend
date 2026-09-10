import { describe, it, expect } from 'vitest';
import { normalizeClientIp } from './utils';
import { safeAttachmentName } from './utils';

/**
 * Regression: a multi-IP x-forwarded-for chain longer than 45 chars overflowed the
 * varchar(45) ip columns and 500'd login. Only the first (client) IP may be stored,
 * hard-capped to the max IPv6 length.
 */
describe('normalizeClientIp', () => {
  it('returns undefined for missing input', () => {
    expect(normalizeClientIp(undefined)).toBeUndefined();
    expect(normalizeClientIp(null)).toBeUndefined();
    expect(normalizeClientIp('')).toBeUndefined();
  });

  it('passes a single IP through', () => {
    expect(normalizeClientIp('203.0.113.7')).toBe('203.0.113.7');
  });

  it('keeps only the first IP of a proxy chain', () => {
    expect(normalizeClientIp('203.0.113.7, 10.0.0.1, 172.16.0.1')).toBe('203.0.113.7');
  });

  it('trims whitespace around the client IP', () => {
    expect(normalizeClientIp('  203.0.113.7 , 10.0.0.1')).toBe('203.0.113.7');
  });

  it('never exceeds 45 chars (varchar(45) columns)', () => {
    const longIpv6 = 'abcd:'.repeat(20);
    const result = normalizeClientIp(longIpv6);
    expect(result!.length).toBeLessThanOrEqual(45);
  });

  it('fits a full-length IPv6 address exactly', () => {
    const maxIpv6 = '0000:0000:0000:0000:0000:ffff:255.255.255.255';
    expect(maxIpv6.length).toBe(45);
    expect(normalizeClientIp(maxIpv6)).toBe(maxIpv6);
  });
});


describe('safeAttachmentName', () => {
  it('strips quotes, newlines and path separators', () => {
    expect(safeAttachmentName('shop"; x=y\r\nEvil: 1.sql.gz')).toBe('shop; x=yEvil: 1.sql.gz');
    expect(safeAttachmentName('../../etc/passwd')).toBe('....etc' + 'passwd');
  });
  it('falls back when nothing safe is left', () => {
    expect(safeAttachmentName('"\n"', 'backup')).toBe('backup');
  });
});
