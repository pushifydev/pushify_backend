import { describe, it, expect } from 'vitest';
import { createLogMasker } from './log-masking';

describe('createLogMasker', () => {
  it('masks values of sensitive-looking keys', () => {
    const m = createLogMasker({ API_KEY: 'sk_live_abc123', DB_PASSWORD: 'hunter22' });
    expect(m.mask('connecting with sk_live_abc123 and hunter22')).toBe(
      'connecting with •••••• and ••••••'
    );
  });

  it('masks long values even for non-sensitive keys', () => {
    const m = createLogMasker({ SOME_CONFIG: 'a-very-long-configuration-value-123' });
    expect(m.mask('using a-very-long-configuration-value-123 now')).toContain('••••••');
  });

  it('does NOT mask short non-sensitive values or trivial words', () => {
    const m = createLogMasker({ NODE_ENV: 'production', PORT: '3000', MODE: 'fast' });
    const line = 'Starting production build on port 3000 in fast mode';
    expect(m.mask(line)).toBe(line);
  });

  it('escapes regex metacharacters in secret values', () => {
    const m = createLogMasker({ TOKEN: 'ab+c(d)*e?[f]' });
    expect(m.mask('token=ab+c(d)*e?[f] ok')).toBe('token=•••••• ok');
  });

  it('masks each line of a multi-line secret (PEM keys)', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7x9z\n-----END RSA PRIVATE KEY-----';
    const m = createLogMasker({ FIREBASE_PRIVATE_KEY: pem });
    expect(m.mask('leak: MIIEowIBAAKCAQEA7x9z')).toBe('leak: ••••••');
  });

  it('addSecrets registers ad-hoc secrets like git tokens', () => {
    const m = createLogMasker({});
    m.addSecrets(['ghp_abcdef123456', undefined, null, 'ok']);
    expect(m.mask('cloning https://x:ghp_abcdef123456@github.com')).toBe(
      'cloning https://x:••••••@github.com'
    );
    // 'ok' too trivial to register
    expect(m.mask('everything ok')).toBe('everything ok');
  });

  it('masks overlapping/longest-first correctly', () => {
    const m = createLogMasker({ SECRET_A: 'abcdef', SECRET_LONG: 'abcdef-ghijkl' });
    expect(m.mask('x abcdef-ghijkl y')).toBe('x •••••• y');
  });

  it('handles repeated occurrences on one line', () => {
    const m = createLogMasker({ MY_TOKEN: 'tok_12345' });
    expect(m.mask('tok_12345 tok_12345')).toBe('•••••• ••••••');
  });
});
