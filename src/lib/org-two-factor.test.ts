import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const rows = vi.hoisted(() => ({ next: [] as unknown[], selects: 0 }));
vi.mock('../db', () => {
  const chain = { from: () => chain, where: () => chain, limit: async () => rows.next };
  return { db: { select: () => { rows.selects++; return chain; } } };
});
const audit = vi.hoisted(() => ({ log: vi.fn() }));
vi.mock('../services/activity.service', () => ({ activityService: { log: audit.log } }));

const {
  isExemptFromOrgTwoFactor,
  isOrganizationTwoFactorRequired,
  invalidateOrgTwoFactorPolicy,
  userHasTwoFactorEnabled,
  orgTwoFactorRequiredError,
  orgTwoFactorRequiredWsError,
  recordOrgTwoFactorDenial,
} = await import('./org-two-factor');

beforeEach(() => {
  rows.next = [];
  rows.selects = 0;
  audit.log.mockReset();
  audit.log.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
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

describe('orgTwoFactorRequiredWsError', () => {
  it('carries the same code and message as the HTTP refusal', () => {
    for (const locale of ['en', 'tr'] as const) {
      const http = orgTwoFactorRequiredError(locale);
      expect(orgTwoFactorRequiredWsError(locale)).toEqual({
        type: 'error',
        code: (http.cause as { code: string }).code,
        message: http.message,
      });
    }
    expect(orgTwoFactorRequiredWsError('en').code).toBe('ORG_2FA_REQUIRED');
  });
});

describe('recordOrgTwoFactorDenial', () => {
  it('writes auth.org_2fa_denied with the access path, source and request facts', async () => {
    await recordOrgTwoFactorDenial({
      organizationId: 'org-a',
      userId: 'user-a',
      accessPath: 'api_key',
      method: 'POST',
      path: '/api/v1/projects/p1/deployments',
      apiKey: { id: 'key-1', name: 'ci' },
      ipAddress: '203.0.113.7',
      userAgent: 'curl',
    });

    expect(audit.log).toHaveBeenCalledWith({
      organizationId: 'org-a',
      userId: 'user-a',
      projectId: undefined,
      action: 'auth.org_2fa_denied',
      description: 'Refused an API key request: the organization requires two-factor authentication',
      metadata: {
        accessPath: 'api_key',
        code: 'ORG_2FA_REQUIRED',
        method: 'POST',
        path: '/api/v1/projects/p1/deployments',
        apiKey: { id: 'key-1', name: 'ci' },
      },
      ipAddress: '203.0.113.7',
      userAgent: 'curl',
      source: 'api',
    });
  });

  it('records WebSocket and terminal refusals as ui, with the project or server', async () => {
    await recordOrgTwoFactorDenial({ organizationId: 'org-b', userId: 'user-b', accessPath: 'websocket', path: '/api/v1/ws' });
    await recordOrgTwoFactorDenial({ organizationId: 'org-b', userId: 'user-b', accessPath: 'server_terminal', serverId: 's1' });
    await recordOrgTwoFactorDenial({ organizationId: 'org-b', userId: 'user-b', accessPath: 'project_shell', projectId: 'p1' });

    expect(audit.log).toHaveBeenCalledTimes(3);
    const [ws, terminal, shell] = audit.log.mock.calls.map(([entry]) => entry);
    expect(ws).toMatchObject({ source: 'ui', metadata: { accessPath: 'websocket', path: '/api/v1/ws' } });
    expect(terminal).toMatchObject({ source: 'ui', metadata: { accessPath: 'server_terminal', serverId: 's1' } });
    expect(shell).toMatchObject({ source: 'ui', projectId: 'p1', metadata: { accessPath: 'project_shell' } });
  });

  it('writes one entry per user, organization and access path every 10 minutes', async () => {
    vi.useFakeTimers();
    const denial = { organizationId: 'org-c', userId: 'user-c', accessPath: 'session' as const };

    await recordOrgTwoFactorDenial(denial);
    await recordOrgTwoFactorDenial(denial);
    expect(audit.log).toHaveBeenCalledTimes(1);

    // Another path, user or organization is its own entry
    await recordOrgTwoFactorDenial({ ...denial, accessPath: 'api_key' });
    await recordOrgTwoFactorDenial({ ...denial, userId: 'user-d' });
    await recordOrgTwoFactorDenial({ ...denial, organizationId: 'org-d' });
    expect(audit.log).toHaveBeenCalledTimes(4);

    vi.advanceTimersByTime(10 * 60_000);
    await recordOrgTwoFactorDenial(denial);
    expect(audit.log).toHaveBeenCalledTimes(5);
  });
});
