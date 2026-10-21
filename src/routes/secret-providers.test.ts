import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';

/**
 * Adding and removing a secret manager connection leaves an entry in the organization's audit
 * log, and the client secret sent with it never reaches that entry.
 */

const CLIENT_SECRET = 'mi_SUPER_SECRET_CLIENT_SECRET_123';

vi.mock('../middleware/auth', () => {
  const mw = async (c: Context, next: () => Promise<void>) => {
    c.set('userId', 'user-1');
    c.set('organizationId', 'org-A');
    c.set('locale', 'en');
    await next();
  };
  return { authMiddleware: mw };
});
vi.mock('../middleware/apikey-auth', () => ({
  rejectApiKeyAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../db', () => ({ db: {} }));

const logged: Array<{ method: string; args: unknown[] }> = [];
const record = (method: string) => vi.fn(async (...args: unknown[]) => { logged.push({ method, args }); });
vi.mock('../services/activity.service', () => ({
  activityService: {
    logSecretProviderConnectionSaved: record('logSecretProviderConnectionSaved'),
    logSecretProviderConnectionRemoved: record('logSecretProviderConnectionRemoved'),
  },
}));

const connection = {
  id: 'sp-1',
  provider: 'infisical',
  projectId: null,
  siteUrl: 'https://app.infisical.com',
  clientId: 'mi-client-1',
  workspaceId: 'ws-1',
  environment: 'prod',
  secretPath: '/',
  lastUsedAt: null,
  createdAt: new Date(),
};
const upsert = vi.fn(async (..._args: unknown[]) => connection);
const remove = vi.fn(async (..._args: unknown[]) => ({ success: true, connection }));
vi.mock('../services/secret-provider.service', () => ({
  secretProviderService: { upsert, remove, list: vi.fn(async () => [connection]) },
}));

const { secretProviderRoutes } = await import('./secret-providers');

beforeEach(() => {
  logged.length = 0;
  upsert.mockClear();
  remove.mockClear();
});

describe('secret provider routes audit', () => {
  it('connecting Infisical is audited without the client secret', async () => {
    const res = await secretProviderRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'user-agent': 'vitest' },
      body: JSON.stringify({
        provider: 'infisical',
        clientId: 'mi-client-1',
        clientSecret: CLIENT_SECRET,
        workspaceId: 'ws-1',
        environment: 'prod',
      }),
    });
    expect(res.status).toBe(201);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(logged).toHaveLength(1);
    expect(logged[0].method).toBe('logSecretProviderConnectionSaved');
    expect(logged[0].args.slice(0, 3)).toEqual(['org-A', 'user-1', connection]);
    expect(logged[0].args[4]).toBe('vitest');
    expect(logged[0].args[5]).toBe('ui');
    expect(JSON.stringify(logged)).not.toContain(CLIENT_SECRET);
  });

  it('removing a connection is audited and the response is unchanged', async () => {
    const res = await secretProviderRoutes.request('/sp-1', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: { success: true } });
    expect(remove).toHaveBeenCalledWith('org-A', 'user-1', 'sp-1', 'en');
    expect(logged).toHaveLength(1);
    expect(logged[0].method).toBe('logSecretProviderConnectionRemoved');
    expect(logged[0].args.slice(0, 3)).toEqual(['org-A', 'user-1', connection]);
  });

  it('a rejected connection is not audited', async () => {
    upsert.mockRejectedValueOnce(new HTTPException(400, { message: 'Client secret is required' }));
    const res = await secretProviderRoutes.request('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: 'infisical' }),
    });
    expect(res.status).toBe(400);
    expect(logged).toHaveLength(0);
  });
});
