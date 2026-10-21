import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Backup codes are how a user who lost their authenticator gets back in. They are stored as
 * argon2 hashes, so these tests use the real password module: a swapped hash/code argument order
 * fails here instead of silently rejecting every code.
 */

type StoredUser = {
  id: string;
  email: string;
  name: string;
  passwordHash: string | null;
  twoFactorEnabled: boolean;
  twoFactorSecret: string | null;
  twoFactorBackupCodes: string | null;
};

const store = vi.hoisted(() => ({ user: null as null | StoredUser }));

vi.mock('../db', () => ({
  db: {
    query: { users: { findFirst: async () => store.user ?? undefined } },
    update: () => ({
      set: (data: Partial<StoredUser>) => ({
        where: async () => {
          if (store.user) Object.assign(store.user, data);
        },
      }),
    }),
  },
}));

vi.mock('../lib/email', () => ({
  sendTwoFactorEnabledEmail: vi.fn(async () => {}),
  sendTwoFactorDisabledEmail: vi.fn(async () => {}),
}));

import { twoFactorService } from './twoFactor.service';
import { hashPassword } from '../lib/password';

const USER_ID = '00000000-0000-0000-0000-000000000001';

function storedCodes(): string[] {
  return JSON.parse(store.user?.twoFactorBackupCodes ?? '[]');
}

/** A 2FA user holding `count` freshly generated backup codes; returns the plain codes. */
async function setUpUser(count: number, passwordHash: string | null = null): Promise<string[]> {
  const codes = twoFactorService.generateBackupCodes().slice(0, count);
  store.user = {
    id: USER_ID,
    email: 'dana@example.com',
    name: 'Dana',
    passwordHash,
    twoFactorEnabled: true,
    twoFactorSecret: null,
    twoFactorBackupCodes: JSON.stringify(await Promise.all(codes.map((c) => hashPassword(c)))),
  };
  return codes;
}

beforeEach(() => {
  store.user = null;
});

describe('verifyBackupCode', () => {
  it('accepts a valid code once and removes it', async () => {
    const codes = await setUpUser(3);

    expect(await twoFactorService.verifyBackupCode(USER_ID, codes[1])).toBe(true);
    expect(storedCodes()).toHaveLength(2);

    expect(await twoFactorService.verifyBackupCode(USER_ID, codes[1])).toBe(false);
    expect(storedCodes()).toHaveLength(2);

    // The remaining codes still work.
    expect(await twoFactorService.verifyBackupCode(USER_ID, codes[0])).toBe(true);
    expect(storedCodes()).toHaveLength(1);
  });

  it('accepts a code typed in lowercase or with surrounding spaces', async () => {
    const codes = await setUpUser(2);

    expect(await twoFactorService.verifyBackupCode(USER_ID, codes[0].toLowerCase())).toBe(true);
    expect(await twoFactorService.verifyBackupCode(USER_ID, ` ${codes[1]} `)).toBe(true);
    expect(storedCodes()).toHaveLength(0);
  });

  it('rejects an unknown code and keeps every stored code', async () => {
    await setUpUser(2);
    const before = storedCodes();

    expect(await twoFactorService.verifyBackupCode(USER_ID, 'ZZZZ0000')).toBe(false);
    expect(storedCodes()).toEqual(before);
  });
});

describe('verifyIdentityForSensitiveAction', () => {
  it('lets an OAuth-only account confirm with a backup code', async () => {
    const codes = await setUpUser(2);

    await expect(
      twoFactorService.verifyIdentityForSensitiveAction(USER_ID, { twoFactorCode: codes[0] })
    ).resolves.toBeUndefined();
    expect(storedCodes()).toHaveLength(1);
  });
});
