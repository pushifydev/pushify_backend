import { describe, it, expect, vi, beforeEach } from 'vitest';

const rows = vi.hoisted(() => ({ next: [] as unknown[], selects: 0 }));
vi.mock('../db', () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => rows.next };
  return { db: { select: () => { rows.selects++; return chain; } } };
});

const {
  isExemptFromOrgTwoFactor,
  isOrganizationTwoFactorRequired,
  invalidateOrgTwoFactorPolicy,
  userHasTwoFactorEnabled,
} = await import('./org-two-factor');

beforeEach(() => {
  rows.next = [];
  rows.selects = 0;
});

describe('isExemptFromOrgTwoFactor', () => {
  it('exempts 2FA setup, profile, logout and switching organization', () => {
    for (const path of [
      '/api/v1/auth/2fa/setup',
      '/api/v1/auth/2fa/enable',
      '/api/v1/auth/2fa/status',
      '/api/v1/auth/me',
      '/api/v1/auth/me/sessions',
      '/api/v1/auth/me/change-password',
      '/api/v1/auth/logout',
      '/api/v1/organizations/switch',
      '/api/v1/organizations/mine',
    ]) {
      expect(isExemptFromOrgTwoFactor(path), path).toBe(true);
    }
  });

  it('does not exempt organization routes or look-alike paths', () => {
    for (const path of [
      '/api/v1/projects',
      '/api/v1/organizations',
      '/api/v1/organizations/members',
      '/api/v1/organizations/two-factor-policy',
      '/api/v1/organizations/switch/extra',
      '/api/v1/auth/meetings',
      '/api/v1/auth/2fa-bypass',
      '/api/v1/auth/logout/x',
      '/api/v2/auth/me',
    ]) {
      expect(isExemptFromOrgTwoFactor(path), path).toBe(false);
    }
  });
});

describe('isOrganizationTwoFactorRequired', () => {
  it('reads the column once, then answers from the cache until invalidated', async () => {
    rows.next = [{ requireTwoFactor: true }];
    expect(await isOrganizationTwoFactorRequired('org-cache')).toBe(true);

    rows.next = [{ requireTwoFactor: false }];
    expect(await isOrganizationTwoFactorRequired('org-cache')).toBe(true);
    expect(rows.selects).toBe(1);

    invalidateOrgTwoFactorPolicy('org-cache');
    expect(await isOrganizationTwoFactorRequired('org-cache')).toBe(false);
    expect(rows.selects).toBe(2);
  });

  it('treats an unknown organization as not requiring it', async () => {
    expect(await isOrganizationTwoFactorRequired('org-missing')).toBe(false);
  });
});

describe('userHasTwoFactorEnabled', () => {
  it('reads the flag every time (no cache), so enabling 2FA takes effect at once', async () => {
    rows.next = [{ twoFactorEnabled: false }];
    expect(await userHasTwoFactorEnabled('user-1')).toBe(false);
    rows.next = [{ twoFactorEnabled: true }];
    expect(await userHasTwoFactorEnabled('user-1')).toBe(true);
    rows.next = [];
    expect(await userHasTwoFactorEnabled('user-gone')).toBe(false);
    expect(rows.selects).toBe(3);
  });
});
