import { describe, expect, it, vi } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import { identifiersFor, normalizeEmailForBan } from './user-ban';

describe('normalizeEmailForBan', () => {
  it('treats Gmail dot, +tag and googlemail variants as one account', () => {
    const base = normalizeEmailForBan('john.doe@gmail.com');
    expect(base).toBe('johndoe@gmail.com');
    for (const v of ['JohnDoe@Gmail.com', 'j.o.h.n.d.o.e+vpn@gmail.com', 'john.doe+x@googlemail.com', '  john.doe@gmail.com ']) {
      expect(normalizeEmailForBan(v)).toBe(base);
    }
  });

  it('drops +tags elsewhere but keeps dots, which other providers treat as different addresses', () => {
    expect(normalizeEmailForBan('A.B+spam@Example.org')).toBe('a.b@example.org');
    expect(normalizeEmailForBan('a.b@example.org')).not.toBe(normalizeEmailForBan('ab@example.org'));
  });
});

describe('identifiersFor', () => {
  it('lists every identifier an account can sign up with', () => {
    expect(identifiersFor({ email: 'x.y@gmail.com', githubId: '42', googleId: null })).toEqual([
      { kind: 'email', value: 'xy@gmail.com' },
      { kind: 'github_id', value: '42' },
    ]);
  });
});
