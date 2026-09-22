import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { dueExpiryWarning, daysLeft, servedCertificateExpiry } from './cert-expiry';

const DAY = 24 * 60 * 60 * 1000;
const expires = new Date('2026-10-30T00:00:00Z');
const at = (daysBefore: number) => new Date(expires.getTime() - daysBefore * DAY);

describe('dueExpiryWarning', () => {
  it('stays quiet until 14 days before', () => {
    expect(dueExpiryWarning(expires, null, at(30))).toBeNull();
    expect(dueExpiryWarning(expires, null, at(14.5))).toBeNull();
  });

  it('warns once inside 14 days, then once more inside 3 days', () => {
    expect(dueExpiryWarning(expires, null, at(13))).toBe('first');
    expect(dueExpiryWarning(expires, at(13), at(10))).toBeNull(); // already told
    expect(dueExpiryWarning(expires, at(13), at(2))).toBe('final');
    expect(dueExpiryWarning(expires, at(2), at(1))).toBeNull();
  });

  it('a first check inside 3 days (or after expiry) sends the final one straight away', () => {
    expect(dueExpiryWarning(expires, null, at(1))).toBe('final');
    expect(dueExpiryWarning(expires, null, at(-5))).toBe('final');
  });

  it('a renewed certificate starts over: warnings for the old one do not count', () => {
    const renewed = new Date(expires.getTime() + 90 * DAY);
    expect(dueExpiryWarning(renewed, at(13), new Date(renewed.getTime() - 10 * DAY))).toBe('first');
  });

  it('counts whole days left', () => {
    expect(daysLeft(expires, at(13.5))).toBe(13);
    expect(daysLeft(expires, at(-1.5))).toBe(-2);
  });
});

describe('servedCertificateExpiry', () => {
  it('reads the expiry of whatever certificate the host serves', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cert-expiry-'));
    execFileSync('openssl', [
      'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '10', '-subj', '/CN=localhost',
      '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'),
    ], { stdio: 'ignore' });
    const server = tls.createServer({ key: readFileSync(path.join(dir, 'key.pem')), cert: readFileSync(path.join(dir, 'cert.pem')) }, (s) => s.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const expiry = await servedCertificateExpiry('127.0.0.1', { port });
      expect(expiry).not.toBeNull();
      expect(daysLeft(expiry!)).toBeGreaterThanOrEqual(9);
      expect(daysLeft(expiry!)).toBeLessThanOrEqual(10);
    } finally {
      server.close();
    }
  });

  it('is null when nothing answers', async () => {
    expect(await servedCertificateExpiry('127.0.0.1', { port: 1, timeoutMs: 2000 })).toBeNull();
  });
});
