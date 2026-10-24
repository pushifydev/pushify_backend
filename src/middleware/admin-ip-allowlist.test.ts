import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { parseCidrList } from '../lib/ip-allowlist';

/**
 * ADMIN_ALLOWED_CIDRS keeps a self-hosted panel off the internet. Built on the real
 * registerMiddleware, so the test sees what the API does: the list unset changes nothing,
 * outsiders get 403, webhooks / the wake page / health probes still answer, and a forged
 * X-Forwarded-For only counts when a trusted proxy wrote it.
 */
const mocks = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  warn: vi.fn(),
}));

vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  Object.assign(mocks.env, actual.env);
  return { env: mocks.env };
});
vi.mock('../lib/logger', () => ({
  logger: { info: vi.fn(), warn: mocks.warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => null }));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findById: async () => ({ plan: 'free' }) },
}));

const { registerMiddleware } = await import('./index');
const { resolveClientIp, isAllowlistExemptPath } = await import('./admin-ip-allowlist');

const TAILNET_V4 = '100.101.102.103';
const TAILNET_V6 = 'fd7a:115c:a1e0:ab12:4843:cd96:6258:b240';
const OUTSIDER_V4 = '203.0.113.9';
const OUTSIDER_V6 = '2001:db8::9';
const PROXY = '172.18.0.1';

function buildApp() {
  const app = new OpenAPIHono();
  registerMiddleware(app);
  // Stand-ins on the real mount paths (routes/index.ts, index.ts)
  app.get('/api/v1/projects', (c) => c.text('projects'));
  app.get('/api/v1/admin/users', (c) => c.text('admin'));
  app.get('/api/v1/ws', (c) => c.text('ws'));
  app.get('/api/docs', (c) => c.text('docs'));
  app.post('/api/v1/webhooks/github/app', (c) => c.text('github-app'));
  app.post('/api/v1/webhooks/github/:projectId', (c) => c.text('github'));
  app.post('/api/v1/webhooks/gitlab/:projectId', (c) => c.text('gitlab'));
  app.post('/api/v1/webhooks/stripe', (c) => c.text('stripe'));
  app.all('/api/v1/wake/:slug', (c) => c.text('wake'));
  app.get('/api/v1/health', (c) => c.text('health'));
  app.get('/api/v1/health/ready', (c) => c.text('ready'));
  app.get('/api/v1/healthz', (c) => c.text('not health'));
  app.get('/api/v1/webhooksx', (c) => c.text('not a webhook'));
  return app;
}

function call(
  app: OpenAPIHono,
  path: string,
  { from, method = 'GET', headers = {} }: { from: string; method?: string; headers?: Record<string, string> },
) {
  return app.request(path, { method, headers }, { incoming: { socket: { remoteAddress: from } } });
}

beforeEach(() => {
  mocks.env.RATE_LIMIT_ENABLED = false;
  mocks.env.TRUSTED_PROXY_HOPS = 0;
  mocks.env.ADMIN_ALLOWED_CIDRS = '100.64.0.0/10,fd7a:115c:a1e0::/48';
  mocks.env.ADMIN_TRUSTED_PROXY_CIDRS = undefined;
  mocks.warn.mockReset();
});

describe('ADMIN_ALLOWED_CIDRS unset or empty', () => {
  it('changes nothing for any address', async () => {
    for (const value of [undefined, '', ' , ']) {
      mocks.env.ADMIN_ALLOWED_CIDRS = value;
      const app = buildApp();
      for (const from of [OUTSIDER_V4, OUTSIDER_V6, '127.0.0.1']) {
        expect((await call(app, '/api/v1/projects', { from })).status).toBe(200);
        expect((await call(app, '/api/v1/admin/users', { from })).status).toBe(200);
      }
    }
  });
});

describe('ADMIN_ALLOWED_CIDRS set', () => {
  it('lets tailnet IPv4 and IPv6 addresses in, including IPv4 on a dual-stack socket', async () => {
    const app = buildApp();
    for (const from of [TAILNET_V4, `::ffff:${TAILNET_V4}`, TAILNET_V6]) {
      const res = await call(app, '/api/v1/projects', { from });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('projects');
    }
  });

  it('answers 403 IP_NOT_ALLOWED to everything else: dashboard API, admin panel, WebSockets, docs', async () => {
    const app = buildApp();
    for (const from of [OUTSIDER_V4, OUTSIDER_V6, '100.128.0.1', 'fd7a:115c:a1e1::1', '127.0.0.1']) {
      for (const path of ['/api/v1/projects', '/api/v1/admin/users', '/api/v1/ws', '/api/docs', '/']) {
        const res = await call(app, path, { from });
        expect(res.status, `${from} ${path}`).toBe(403);
        expect((await res.json()).error.code).toBe('IP_NOT_ALLOWED');
      }
    }
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ip_not_allowed', ip: OUTSIDER_V4, socketIp: OUTSIDER_V4 }),
      expect.any(String),
    );
  });

  it('refuses a request whose socket address cannot be read', async () => {
    const app = buildApp();
    const res = await app.request('/api/v1/projects', {}, { incoming: { socket: {} } });
    expect(res.status).toBe(403);
  });

  it('keeps webhooks, the wake page of deployed apps and health probes open to anyone', async () => {
    const app = buildApp();
    const open: [string, string, string][] = [
      ['POST', '/api/v1/webhooks/github/app', 'github-app'],
      ['POST', '/api/v1/webhooks/github/00000000-0000-4000-8000-000000000000', 'github'],
      ['POST', '/api/v1/webhooks/gitlab/00000000-0000-4000-8000-000000000000', 'gitlab'],
      ['POST', '/api/v1/webhooks/stripe', 'stripe'],
      ['GET', '/api/v1/wake/my-app', 'wake'],
      ['POST', '/api/v1/wake/my-app', 'wake'],
      ['GET', '/api/v1/health', 'health'],
      ['GET', '/api/v1/health/ready', 'ready'],
    ];
    for (const from of [OUTSIDER_V4, OUTSIDER_V6, '127.0.0.1']) {
      for (const [method, path, body] of open) {
        const res = await call(app, path, { from, method });
        expect(res.status, `${from} ${method} ${path}`).toBe(200);
        expect(await res.text()).toBe(body);
      }
    }
  });

  it('exempts whole path segments only, and not via dot segments', async () => {
    const app = buildApp();
    expect((await call(app, '/api/v1/healthz', { from: OUTSIDER_V4 })).status).toBe(403);
    expect((await call(app, '/api/v1/webhooksx', { from: OUTSIDER_V4 })).status).toBe(403);
    expect((await call(app, '/api/v1/webhooks/../admin/users', { from: OUTSIDER_V4 })).status).toBe(403);
    expect((await call(app, '/api/v1/health/%2e%2e/admin/users', { from: OUTSIDER_V4 })).status).toBe(403);
    expect(isAllowlistExemptPath('/api/v1/webhooks')).toBe(true);
    expect(isAllowlistExemptPath('/api/v1/projects/x/wake')).toBe(false);
  });

  it('ignores a forged X-Forwarded-For on a direct connection, even with TRUSTED_PROXY_HOPS set', async () => {
    for (const hops of [0, 1, 2]) {
      mocks.env.TRUSTED_PROXY_HOPS = hops;
      const app = buildApp();
      const res = await call(app, '/api/v1/projects', {
        from: OUTSIDER_V4,
        headers: { 'x-forwarded-for': `${TAILNET_V4}, ${TAILNET_V4}` },
      });
      expect(res.status).toBe(403);
    }
  });

  it('reads the client from X-Forwarded-For only when a trusted proxy connects', async () => {
    mocks.env.ADMIN_TRUSTED_PROXY_CIDRS = PROXY;
    const app = buildApp();
    // Tailnet client through the proxy
    expect((await call(app, '/api/v1/projects', { from: PROXY, headers: { 'x-forwarded-for': TAILNET_V4 } })).status).toBe(200);
    expect((await call(app, '/api/v1/projects', { from: `::ffff:${PROXY}`, headers: { 'x-forwarded-for': TAILNET_V6 } })).status).toBe(200);
    // Outsider through the proxy, with a forged entry in front of the one the proxy appended
    expect(
      (await call(app, '/api/v1/projects', { from: PROXY, headers: { 'x-forwarded-for': `${TAILNET_V4}, ${OUTSIDER_V4}` } })).status,
    ).toBe(403);
    // Proxy without the header: judged by its own address, which is not allowlisted
    expect((await call(app, '/api/v1/projects', { from: PROXY })).status).toBe(403);
    // Garbage the proxy passed on: refused rather than guessed
    expect((await call(app, '/api/v1/projects', { from: PROXY, headers: { 'x-forwarded-for': 'unknown' } })).status).toBe(403);
    // Someone else sending the header directly
    expect((await call(app, '/api/v1/projects', { from: OUTSIDER_V4, headers: { 'x-forwarded-for': TAILNET_V4 } })).status).toBe(403);
  });

  it('refuses to start on a wrong entry instead of leaving the API open', () => {
    mocks.env.ADMIN_ALLOWED_CIDRS = '100.64.0.0/10,tailnet';
    expect(() => buildApp()).toThrow(/ADMIN_ALLOWED_CIDRS: "tailnet"/);
    mocks.env.ADMIN_ALLOWED_CIDRS = '100.64.0.0/10';
    mocks.env.ADMIN_TRUSTED_PROXY_CIDRS = '172.18.0.1/40';
    expect(() => buildApp()).toThrow(/ADMIN_TRUSTED_PROXY_CIDRS/);
  });
});

describe('resolveClientIp', () => {
  const none = parseCidrList(undefined, 'X');
  const proxies = parseCidrList('10.0.0.0/8', 'X');

  it('uses the socket address and ignores the header when no proxy is trusted', () => {
    expect(resolveClientIp(OUTSIDER_V4, TAILNET_V4, none)).toBe(OUTSIDER_V4);
    expect(resolveClientIp(`::ffff:${OUTSIDER_V4}`, undefined, none)).toBe(OUTSIDER_V4);
  });

  it('walks back through every trusted hop and stops at the first untrusted one', () => {
    expect(resolveClientIp('10.0.0.2', `${TAILNET_V4}, 10.0.0.3`, proxies)).toBe(TAILNET_V4);
    expect(resolveClientIp('10.0.0.2', `${TAILNET_V4}, ${OUTSIDER_V4}, 10.0.0.3`, proxies)).toBe(OUTSIDER_V4);
    expect(resolveClientIp('10.0.0.2', '10.0.0.4, 10.0.0.3', proxies)).toBe('10.0.0.4');
  });

  it('returns null when the socket or a believed entry is not an address', () => {
    expect(resolveClientIp(undefined, TAILNET_V4, proxies)).toBeNull();
    expect(resolveClientIp('10.0.0.2', `${TAILNET_V4}, garbage`, proxies)).toBeNull();
  });
});
