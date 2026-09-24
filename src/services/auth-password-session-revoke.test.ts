import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * Changing or resetting a password is the user's way to recover after a takeover. It is only
 * worth anything if refresh tokens issued before the change stop working — otherwise an attacker
 * holding one keeps minting access tokens via `/refresh` until it expires.
 */

type Session = { id: string; userId: string; tokenHash: string; expiresAt: Date };

const store = vi.hoisted(() => ({
  sessions: [] as Session[],
  user: null as null | { id: string; email: string; name: string; passwordHash: string | null },
  resetToken: null as null | { userId: string; tokenHash: string; expiresAt: Date },
  seq: 0,
}));

vi.mock('../repositories/user.repository', () => ({
  userRepository: {
    findById: async (id: string) => (store.user?.id === id ? store.user : undefined),
    update: async (id: string, data: Record<string, unknown>) => {
      if (store.user?.id === id) Object.assign(store.user, data);
      return store.user;
    },
    createSession: async (input: Omit<Session, 'id'>) => {
      const s = { ...input, id: `s${++store.seq}` };
      store.sessions.push(s);
      return s;
    },
    findSessionByTokenHash: async (tokenHash: string) =>
      store.sessions.find((s) => s.tokenHash === tokenHash),
    deleteSessionByTokenHash: async (tokenHash: string) => {
      store.sessions = store.sessions.filter((s) => s.tokenHash !== tokenHash);
    },
    deleteAllSessions: async (userId: string) => {
      store.sessions = store.sessions.filter((s) => s.userId !== userId);
    },
    deleteOtherSessions: async (userId: string, exceptId: string) => {
      store.sessions = store.sessions.filter((s) => s.userId !== userId || s.id === exceptId);
    },
    findPasswordResetTokenByHash: async (tokenHash: string) =>
      store.resetToken?.tokenHash === tokenHash ? store.resetToken : undefined,
    deletePasswordResetTokensByUserId: async () => {
      store.resetToken = null;
    },
  },
}));

vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: {
    findUserFirstOrganization: async () => ({ organizationId: 'org-1' }),
  },
}));

vi.mock('../lib/password', () => ({
  hashPassword: async (p: string) => `hash:${p}`,
  verifyPassword: async (hash: string, p: string) => hash === `hash:${p}`,
}));

vi.mock('../lib/email', () => ({
  sendPasswordResetEmail: vi.fn(async () => {}),
  sendEmailVerificationEmail: vi.fn(async () => {}),
  sendWelcomeEmail: vi.fn(async () => {}),
  sendPasswordChangedEmail: vi.fn(async () => {}),
  sendNewLoginEmail: vi.fn(async () => {}),
}));

import { authService } from './auth.service';
import { generateTokenPair } from '../lib/jwt';
import { hashToken } from '../lib/utils';

const USER_ID = '00000000-0000-0000-0000-000000000001';

// Refresh tokens carry only sub/type/iat (no jti), so two issued in the same second for the same
// user are byte-identical. Move the clock forward per sign-in to keep test sessions distinct.
async function signIn(): Promise<string> {
  vi.setSystemTime(Date.now() + 2_000);
  const { refreshToken } = await generateTokenPair(USER_ID, 'org-1');
  await authService.createSession(USER_ID, refreshToken);
  return refreshToken;
}

async function refreshStatus(refreshToken: string) {
  try {
    await authService.refreshAccessToken(refreshToken);
    return { status: 200, message: 'ok' };
  } catch (err) {
    if (err instanceof HTTPException) return { status: err.status, message: err.message };
    throw err;
  }
}

const SESSION_NOT_FOUND = { status: 401, message: 'Session not found or expired' };

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  store.sessions = [];
  store.seq = 0;
  store.user = { id: USER_ID, email: 'dana@example.com', name: 'Dana', passwordHash: 'hash:OldPass123' };
  store.resetToken = null;
});

describe('resetPassword', () => {
  it('revokes every existing session', async () => {
    const stolen = await signIn();
    const other = await signIn();

    store.resetToken = {
      userId: USER_ID,
      tokenHash: await hashToken('reset-token'),
      expiresAt: new Date(Date.now() + 60_000),
    };
    await authService.resetPassword('reset-token', 'NewPass123');

    expect(await refreshStatus(stolen)).toEqual(SESSION_NOT_FOUND);
    expect(await refreshStatus(other)).toEqual(SESSION_NOT_FOUND);
    expect(store.sessions).toHaveLength(0);
  });
});

describe('changePassword', () => {
  it('revokes all sessions when no refresh token is given', async () => {
    const stolen = await signIn();

    await authService.changePassword(USER_ID, { currentPassword: 'OldPass123', newPassword: 'NewPass123' });

    expect(await refreshStatus(stolen)).toEqual(SESSION_NOT_FOUND);
    expect(store.sessions).toHaveLength(0);
  });

  it('keeps the current session and revokes the others when the refresh token is given', async () => {
    const stolen = await signIn();
    const current = await signIn();

    await authService.changePassword(USER_ID, {
      currentPassword: 'OldPass123',
      newPassword: 'NewPass123',
      refreshToken: current,
    });

    expect(await refreshStatus(stolen)).toEqual(SESSION_NOT_FOUND);
    expect((await refreshStatus(current)).status).toBe(200);
  });

  it('does not keep a session that belongs to another user', async () => {
    const mine = await signIn();
    const { refreshToken: foreign } = await generateTokenPair('someone-else', 'org-2');
    await authService.createSession('someone-else', foreign);

    await authService.changePassword(USER_ID, {
      currentPassword: 'OldPass123',
      newPassword: 'NewPass123',
      refreshToken: foreign,
    });

    expect(await refreshStatus(mine)).toEqual(SESSION_NOT_FOUND);
    // The other user's session is untouched.
    expect(store.sessions.map((s) => s.userId)).toEqual(['someone-else']);
  });

  it('does not touch sessions when the current password is wrong', async () => {
    const existing = await signIn();

    await expect(
      authService.changePassword(USER_ID, { currentPassword: 'Wrong', newPassword: 'NewPass123' })
    ).rejects.toBeInstanceOf(HTTPException);

    expect(store.sessions).toHaveLength(1);
    expect((await refreshStatus(existing)).status).toBe(200);
  });
});
