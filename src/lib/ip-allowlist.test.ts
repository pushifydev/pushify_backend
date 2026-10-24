import { describe, it, expect } from 'vitest';
import { normalizeIp, parseCidrList } from './ip-allowlist';

describe('normalizeIp', () => {
  it('turns an IPv4 client on a dual-stack socket into its IPv4 address', () => {
    expect(normalizeIp('::ffff:100.101.102.103')).toBe('100.101.102.103');
    expect(normalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });

  it('drops brackets, ports and IPv6 zones, and lowercases IPv6', () => {
    expect(normalizeIp('[2001:DB8::1]')).toBe('2001:db8::1');
    expect(normalizeIp('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(normalizeIp('203.0.113.7:51234')).toBe('203.0.113.7');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp(' 198.51.100.1 ')).toBe('198.51.100.1');
  });

  it('returns null for anything that is not an IP address', () => {
    for (const value of [undefined, null, '', 'unknown', 'example.com', '300.1.1.1', '1.2.3', '::ffff:999.1.1.1']) {
      expect(normalizeIp(value)).toBeNull();
    }
  });
});

describe('parseCidrList', () => {
  it('is empty when unset, empty or only separators', () => {
    for (const raw of [undefined, '', '   ', ' , ,']) {
      const list = parseCidrList(raw, 'X');
      expect(list.size).toBe(0);
      expect(list.contains('100.64.0.1')).toBe(false);
    }
  });

  it('matches an IPv4 CIDR (Tailscale 100.64.0.0/10) at its edges only', () => {
    const list = parseCidrList('100.64.0.0/10', 'X');
    expect(list.size).toBe(1);
    expect(list.contains('100.64.0.0')).toBe(true);
    expect(list.contains('100.101.102.103')).toBe(true);
    expect(list.contains('100.127.255.255')).toBe(true);
    expect(list.contains('100.63.255.255')).toBe(false);
    expect(list.contains('100.128.0.0')).toBe(false);
    expect(list.contains('::ffff:100.101.102.103')).toBe(true);
  });

  it('covers the whole network when the entry has host bits set', () => {
    const list = parseCidrList('100.101.102.103/10', 'X');
    expect(list.contains('100.64.0.1')).toBe(true);
    expect(list.contains('100.128.0.1')).toBe(false);
  });

  it('matches an IPv6 CIDR (Tailscale fd7a:115c:a1e0::/48)', () => {
    const list = parseCidrList('fd7a:115c:a1e0::/48', 'X');
    expect(list.contains('fd7a:115c:a1e0::1')).toBe(true);
    expect(list.contains('fd7a:115c:a1e0:ab12:4843:cd96:6258:b240')).toBe(true);
    expect(list.contains('FD7A:115C:A1E0::5')).toBe(true);
    expect(list.contains('fd7a:115c:a1e1::1')).toBe(false);
    expect(list.contains('2001:db8::1')).toBe(false);
  });

  it('treats a bare address as a single host and mixes families in one list', () => {
    const list = parseCidrList(' 203.0.113.7 , 2001:db8::/32,192.168.1.0/24 ', 'X');
    expect(list.size).toBe(3);
    expect(list.contains('203.0.113.7')).toBe(true);
    expect(list.contains('203.0.113.8')).toBe(false);
    expect(list.contains('2001:db8:1234::9')).toBe(true);
    expect(list.contains('192.168.1.200')).toBe(true);
    expect(list.contains('192.168.2.1')).toBe(false);
  });

  it('never matches across address families', () => {
    expect(parseCidrList('0.0.0.0/0', 'X').contains('2001:db8::1')).toBe(false);
    expect(parseCidrList('::/0', 'X').contains('203.0.113.7')).toBe(false);
  });

  it('does not match values that are not addresses', () => {
    const list = parseCidrList('0.0.0.0/0', 'X');
    expect(list.contains(undefined)).toBe(false);
    expect(list.contains('unknown')).toBe(false);
  });

  it('throws on a wrong entry, naming the variable, instead of skipping it', () => {
    for (const bad of ['tailnet', '10.0.0.0/33', '2001:db8::/129', '10.0.0.0/8/1', '10.0.0.0/', '10.0.0.0/abc', '300.1.1.1', '10.0.0.0/-1', 'fe80::1%eth0']) {
      expect(() => parseCidrList(`100.64.0.0/10,${bad}`, 'ADMIN_ALLOWED_CIDRS')).toThrow(/ADMIN_ALLOWED_CIDRS/);
    }
  });
});
