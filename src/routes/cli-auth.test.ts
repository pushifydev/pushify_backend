import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  create: vi.fn(),
  pending: vi.fn(),
  required: vi.fn(),
  hasTwoFactor: vi.fn(),
  denied: vi.fn(),
}));

vi.mock('../services/apikey.service', () => ({ apiKeyService: { create: h.create } }));
vi.mock('../lib/deletion-lock', () => ({ isOrganizationPendingDeletion: h.pending }));
vi.mock('../lib/org-two-factor', () => ({
  isOrganizationTwoFactorRequired: h.required,
  userHasTwoFactorEnabled: h.hasTwoFactor,
  recordOrgTwoFactorDenial: h.denied,
}));
// Process memory, as without REDIS_URL (the Redis path is covered in lib/cli-auth-store.test.ts).
vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => null }));
vi.mock('../middleware/rate-limit', () => ({ authRateLimiter: async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: { set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('organizationId', 'org-1');
    await next();
  },
}));

import { cliAuthRoutes } from './cli-auth';

async function createSession() {
  const res = await cliAuthRoutes.request('/create-session', { method: 'POST' });
  return ((await res.json()) as { code: string }).code;
}
const approve = (code: string) =>
  cliAuthRoutes.request('/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
const poll = async (code: string) => (await cliAuthRoutes.request(`/poll/${code}`)).json() as Promise<{ status: string; apiKey: string | null }>;

describe('CLI device login', () => {
  beforeEach(() => {
    h.create.mockReset().mockResolvedValue({ secretKey: 'pk_live_secret' });
    h.pending.mockReset().mockResolvedValue(false);
    h.required.mockReset().mockResolvedValue(false);
    h.hasTwoFactor.mockReset().mockResolvedValue(false);
    h.denied.mockReset().mockResolvedValue(undefined);
  });

  it('creates the key when the CLI collects it, once', async () => {
    const code = await createSession();
    expect((await approve(code)).status).toBe(200);
    expect(h.create).not.toHaveBeenCalled(); // nothing issued, nothing held, until collected

    expect(await poll(code)).toEqual({ status: 'approved', apiKey: 'pk_live_secret' });
    expect(h.create).toHaveBeenCalledWith('user-1', 'org-1', expect.objectContaining({ scopes: ['*'] }));
    expect(await poll(code)).toEqual({ status: 'expired', apiKey: null });
    expect(h.create).toHaveBeenCalledTimes(1);
  });

  it('issues no key for an approval that is never collected', async () => {
    const code = await createSession();
    await approve(code);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('issues no key once the organization is scheduled for deletion', async () => {
    const code = await createSession();
    await approve(code);
    h.pending.mockResolvedValue(true);
    expect(await poll(code)).toEqual({ status: 'expired', apiKey: null });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('issues no key once the organization requires 2FA and the user has none, and audits it', async () => {
    const code = await createSession();
    await approve(code);
    h.required.mockResolvedValue(true);

    expect(await poll(code)).toEqual({ status: 'expired', apiKey: null });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.required).toHaveBeenCalledWith('org-1');
    expect(h.hasTwoFactor).toHaveBeenCalledWith('user-1');
    expect(h.denied).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: 'org-1', userId: 'user-1', accessPath: 'cli_login' }),
    );
    // The login code is never written to the audit entry
    expect(JSON.stringify(h.denied.mock.calls)).not.toContain(code);
  });

  it('issues the key when the organization requires 2FA and the user has it', async () => {
    const code = await createSession();
    await approve(code);
    h.required.mockResolvedValue(true);
    h.hasTwoFactor.mockResolvedValue(true);

    expect(await poll(code)).toEqual({ status: 'approved', apiKey: 'pk_live_secret' });
    expect(h.denied).not.toHaveBeenCalled();
  });

  it('reports pending before approval', async () => {
    const code = await createSession();
    expect(await poll(code)).toEqual({ status: 'pending', apiKey: null });
  });
});
