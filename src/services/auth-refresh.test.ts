import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * A multi-org user who switched to org B must stay in org B when their access token is
 * refreshed; silently landing back in the first org would send later writes (deploys, env
 * vars, deletes) to an organization the user did not pick.
 */
const USER = 'user-1';
const FIRST_ORG = 'org-a';
const SECOND_ORG = 'org-b';

const mocks = vi.hoisted(() => ({
  findMember: vi.fn(),
  findById: vi.fn(),
  findUserFirstOrganization: vi.fn(),
  findSessionByTokenHash: vi.fn(),
  deleteSessionByTokenHash: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock('../db', () => ({ db: {} }));

// Real implementation, wrapped so tests can assert whether new tokens were minted.
vi.mock('../lib/jwt', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/jwt')>();
  return { ...actual, generateTokenPair: vi.fn(actual.generateTokenPair) };
});

vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: {
    findMember: mocks.findMember,
    findById: mocks.findById,
    findUserFirstOrganization: mocks.findUserFirstOrganization,
  },
}));

vi.mock('../repositories/user.repository', () => ({
  userRepository: {
    findSessionByTokenHash: mocks.findSessionByTokenHash,
    deleteSessionByTokenHash: mocks.deleteSessionByTokenHash,
    createSession: mocks.createSession,
    // createSession checks for a pending account deletion first
    findById: async (id: string) => ({ id, deletionScheduledFor: null }),
  },
}));

vi.mock('../lib/email', () => ({
  sendPasswordResetEmail: vi.fn(),
  sendEmailVerificationEmail: vi.fn(),
  sendWelcomeEmail: vi.fn(),
  sendPasswordChangedEmail: vi.fn(),
  sendNewLoginEmail: vi.fn(),
}));

vi.mock('./admin-notify.service', () => ({ adminNotify: {} }));
vi.mock('./auth-event.service', () => ({ recordAuthEvent: vi.fn() }));

import { authService } from './auth.service';
import { verifyToken, generateTokenPair } from '../lib/jwt';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findMember.mockResolvedValue({ organizationId: SECOND_ORG, userId: USER, role: 'member' });
  mocks.findById.mockResolvedValue({ id: SECOND_ORG, name: 'Org B', slug: 'org-b' });
  mocks.findUserFirstOrganization.mockResolvedValue({ organizationId: FIRST_ORG, userId: USER });
  mocks.findSessionByTokenHash.mockResolvedValue({ id: 'session-1', userId: USER });
  mocks.deleteSessionByTokenHash.mockResolvedValue(1);
  mocks.createSession.mockResolvedValue(undefined);
});

describe('refreshAccessToken keeps the active organization', () => {
  it('switch → refresh stays in the switched-to org', async () => {
    const switched = await authService.switchOrganization(USER, SECOND_ORG);
    expect((await verifyToken(switched.refreshToken)).org).toBe(SECOND_ORG);

    const refreshed = await authService.refreshAccessToken(switched.refreshToken);

    expect(mocks.findMember).toHaveBeenLastCalledWith(SECOND_ORG, USER);
    expect(mocks.findUserFirstOrganization).not.toHaveBeenCalled();
    expect((await verifyToken(refreshed.accessToken)).org).toBe(SECOND_ORG);
    // The rotated refresh token keeps the org too, so the next refresh also stays put.
    expect((await verifyToken(refreshed.refreshToken)).org).toBe(SECOND_ORG);
  });

  it('falls back to the first org when the user is no longer a member of the active org', async () => {
    const { refreshToken } = await generateTokenPair(USER, SECOND_ORG);
    mocks.findMember.mockResolvedValue(undefined);

    const refreshed = await authService.refreshAccessToken(refreshToken);

    expect(mocks.findMember).toHaveBeenCalledWith(SECOND_ORG, USER);
    expect((await verifyToken(refreshed.accessToken)).org).toBe(FIRST_ORG);
  });

  it('uses the first org for legacy refresh tokens without an org claim', async () => {
    const { refreshToken } = await generateTokenPair(USER);

    const refreshed = await authService.refreshAccessToken(refreshToken);

    expect(mocks.findMember).not.toHaveBeenCalled();
    expect((await verifyToken(refreshed.accessToken)).org).toBe(FIRST_ORG);
  });

  it('rejects an access token used as a refresh token', async () => {
    const { accessToken } = await generateTokenPair(USER, SECOND_ORG);
    await expect(authService.refreshAccessToken(accessToken)).rejects.toBeInstanceOf(HTTPException);
  });
});

describe('refreshAccessToken consumes the session atomically', () => {
  it('returns 401 when the session was already consumed (0 rows deleted)', async () => {
    const { refreshToken } = await generateTokenPair(USER, SECOND_ORG);
    mocks.deleteSessionByTokenHash.mockResolvedValue(0);

    await expect(authService.refreshAccessToken(refreshToken)).rejects.toMatchObject({ status: 401 });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it('does not mint new tokens when the session was already consumed', async () => {
    const { refreshToken } = await generateTokenPair(USER, SECOND_ORG);
    vi.mocked(generateTokenPair).mockClear();
    mocks.deleteSessionByTokenHash.mockResolvedValue(0);

    await expect(authService.refreshAccessToken(refreshToken)).rejects.toBeInstanceOf(HTTPException);
    expect(generateTokenPair).not.toHaveBeenCalled();
  });

  it('only one of two concurrent refreshes with the same token succeeds', async () => {
    const { refreshToken } = await generateTokenPair(USER, SECOND_ORG);
    let remaining = 1;
    mocks.deleteSessionByTokenHash.mockImplementation(async () => {
      const n = remaining;
      remaining = 0;
      return n;
    });

    const results = await Promise.allSettled([
      authService.refreshAccessToken(refreshToken),
      authService.refreshAccessToken(refreshToken),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(mocks.createSession).toHaveBeenCalledTimes(1);
  });
});

describe('switchOrganization', () => {
  it('refuses an org the user is not a member of', async () => {
    mocks.findMember.mockResolvedValue(undefined);
    await expect(authService.switchOrganization(USER, SECOND_ORG)).rejects.toMatchObject({ status: 403 });
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
