import { describe, it, expect } from 'vitest';
import { scrubSecrets } from './ops-scrub';

describe('scrubSecrets', () => {
  const cases: Array<[string, string]> = [
    ['clone failed: https://x-access-token:gho_abcdefghijklmnopqrstuvwxyz0123@github.com/a/b.git', 'gho_'],
    ['token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 rejected', 'ghp_'],
    ['DATABASE_URL=postgres://u:hunter2@db:5432/app', 'hunter2'],
    ['export STRIPE_SECRET_KEY="sk_live_51Habcdefghijkl" && npm run build', 'sk_live_'],
    ['API_KEY: abc123secretvalue', 'abc123secretvalue'],
    ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJhbGci'],
    ['aws AKIAIOSFODNN7EXAMPLE denied', 'AKIAIOSFODNN7EXAMPLE'],
    ['-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1'],
    ['session 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 expired', '9f86d081884c7d65'],
  ];

  for (const [input, secret] of cases) {
    it(`removes ${secret}`, () => {
      const out = scrubSecrets(input)!;
      expect(out).not.toContain(secret);
    });
  }

  it('keeps an ordinary error readable', () => {
    expect(scrubSecrets('npm ERR! Missing script: "build"')).toBe('npm ERR! Missing script: "build"');
    expect(scrubSecrets('Error: listen EADDRINUSE: address already in use :::3000')).toBe(
      'Error: listen EADDRINUSE: address already in use :::3000',
    );
  });

  it('caps the length and handles empty input', () => {
    expect(scrubSecrets('x '.repeat(500))!.length).toBeLessThanOrEqual(301);
    expect(scrubSecrets(null)).toBeNull();
    expect(scrubSecrets('')).toBeNull();
  });
});
