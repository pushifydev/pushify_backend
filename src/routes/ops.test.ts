import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The ops endpoint hands platform-wide signals to a bot, so the token check is its whole
 * security model. Walks the router's own route table: a route added later is covered too.
 */
const TOKEN = 'a'.repeat(40);

const mocks = vi.hoisted(() => ({ env: { OPS_READ_TOKEN: undefined as string | undefined }, getSignals: vi.fn() }));

vi.mock('../config/env', () => ({ env: mocks.env }));
vi.mock('../services/ops-signals.service', () => ({ opsSignalsService: { getSignals: mocks.getSignals } }));
vi.mock('../services/ops-growth.service', () => ({ opsGrowthService: { getGrowth: mocks.getSignals } }));

import { opsRoutes, tokenMatches } from './ops';

const endpoints = opsRoutes.routes.filter((r) => r.method !== 'ALL').map((r) => ({ method: r.method, path: r.path }));
const call = (path: string, method: string, headers: Record<string, string> = {}) => opsRoutes.request(path, { method, headers });

beforeEach(() => {
  mocks.env.OPS_READ_TOKEN = TOKEN;
  mocks.getSignals.mockReset().mockResolvedValue({ ok: true });
});

describe('ops routes', () => {
  it('has routes to test', () => {
    expect(endpoints.length).toBeGreaterThan(0);
  });

  for (const { method, path } of endpoints) {
    describe(`${method} ${path}`, () => {
      it('is invisible without a token', async () => {
        expect((await call(path, method)).status).toBe(404);
      });
      it('is invisible with a wrong token', async () => {
        expect((await call(path, method, { authorization: `Bearer ${'b'.repeat(40)}` })).status).toBe(404);
        expect((await call(path, method, { authorization: TOKEN })).status).toBe(404); // no Bearer
      });
      it('is disabled when OPS_READ_TOKEN is unset, whatever is presented', async () => {
        mocks.env.OPS_READ_TOKEN = undefined;
        expect((await call(path, method, { authorization: 'Bearer ' })).status).toBe(404);
        expect((await call(path, method, { authorization: `Bearer ${TOKEN}` })).status).toBe(404);
      });
      it('serves the right token, uncached', async () => {
        const res = await call(path, method, { authorization: `Bearer ${TOKEN}` });
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-store');
      });
    });
  }

  it('compares tokens without throwing on different lengths', () => {
    expect(tokenMatches('short', TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, undefined)).toBe(false);
  });
});
