import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ create: vi.fn(), pending: vi.fn() }));

vi.mock('../services/apikey.service', () => ({ apiKeyService: { create: h.create } }));
vi.mock('../lib/deletion-lock', () => ({ isOrganizationPendingDeletion: h.pending }));
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

  it('reports pending before approval', async () => {
    const code = await createSession();
    expect(await poll(code)).toEqual({ status: 'pending', apiKey: null });
  });
});
