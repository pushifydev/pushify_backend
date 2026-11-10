import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  limited: [] as string[],
  authed: [] as string[],
  verifyAuthentication: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('../middleware/rate-limit', () => ({
  authRateLimiter: async (c: { req: { path: string } }, next: () => Promise<void>) => {
    h.limited.push(c.req.path);
    await next();
  },
  passwordResetRateLimiter: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../middleware/auth', () => ({
  authMiddleware: async (c: { req: { path: string }; set: (k: string, v: string) => void }, next: () => Promise<void>) => {
    h.authed.push(c.req.path);
    c.set('userId', 'user-1');
    c.set('locale', 'en');
    await next();
  },
}));
vi.mock('../middleware/apikey-auth', () => ({ rejectApiKeyAuth: () => async (_c: unknown, next: () => Promise<void>) => next() }));
vi.mock('../services/passkey.service', () => ({
  passkeyService: {
    authenticationOptions: async () => ({ challenge: 'abc', rpId: 'localhost', timeout: 300000, userVerification: 'required', allowCredentials: [] }),
    verifyAuthentication: h.verifyAuthentication,
    remove: h.remove,
  },
}));

import { passkeyRoutes } from './passkeys';

const assertion = {
  credential: {
    id: 'AAAA',
    rawId: 'AAAA',
    type: 'public-key',
    response: { clientDataJSON: 'e30', authenticatorData: 'AAAA', signature: 'AAAA', userHandle: 'AAAA' },
  },
};
const post = (path: string, body: unknown) =>
  passkeyRoutes.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(() => {
  h.limited = [];
  h.authed = [];
  h.verifyAuthentication.mockReset();
  h.remove.mockReset().mockResolvedValue({ message: 'Passkey removed' });
});

describe('passkey routes', () => {
  it('rate limits the public sign-in routes without asking for a session', async () => {
    expect((await post('/login/options', {})).status).toBe(200);
    h.verifyAuthentication.mockResolvedValue({ requiresTwoFactor: true, twoFactorToken: 'tf' });
    expect((await post('/login/verify', assertion)).status).toBe(200);

    expect(h.limited).toEqual(['/login/options', '/login/verify']);
    expect(h.authed).toEqual([]);
  });

  it('answers a sign-in like POST /auth/login', async () => {
    h.verifyAuthentication.mockResolvedValue({
      user: { id: 'user-1', email: 'a@b.c', name: 'A', avatarUrl: null, emailVerified: true, twoFactorEnabled: false },
      organization: { id: 'org-1', name: 'Acme', slug: 'acme' },
      accessToken: 'at',
      refreshToken: 'rt',
    });
    const body = await (await post('/login/verify', assertion)).json();
    expect(body).toMatchObject({ data: { user: { id: 'user-1' }, organization: { id: 'org-1' } }, accessToken: 'at', refreshToken: 'rt' });
  });

  it('refuses a body that is not base64url before verifying anything', async () => {
    const bad = { credential: { ...assertion.credential, response: { ...assertion.credential.response, signature: 'not base64!' } } };
    expect((await post('/login/verify', bad)).status).toBe(400);
    expect(h.verifyAuthentication).not.toHaveBeenCalled();
  });

  it('removes a passkey with a session', async () => {
    const id = '0b6f3a52-1c4e-4f1a-9e7d-2f3a4b5c6d7e';
    const res = await passkeyRoutes.request(`/${id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(h.authed).toEqual([`/${id}`]);
    expect(h.remove).toHaveBeenCalledWith('user-1', id, 'en', expect.any(Object));
  });

  it('documents every passkey route in the OpenAPI spec', () => {
    const doc = passkeyRoutes.getOpenAPIDocument({ openapi: '3.0.0', info: { title: 'test', version: '1' } });
    expect(Object.keys(doc.paths ?? {}).sort()).toEqual([
      '/',
      '/login/options',
      '/login/verify',
      '/register/options',
      '/register/verify',
      '/{passkeyId}',
    ]);
  });
});
