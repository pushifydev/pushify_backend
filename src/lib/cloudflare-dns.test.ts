import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockEnv = vi.hoisted(() => ({
  env: { CLOUDFLARE_API_TOKEN: 'token', CLOUDFLARE_ZONE_ID: 'zone', PREVIEW_BASE_URL: 'pushify.dev' } as Record<string, string | undefined>,
}));
vi.mock('../config/env', () => mockEnv);

import { deleteAutoSubdomainRecord, ensureAutoSubdomainRecord, hostnameOf, OUR_COMMENT } from './cloudflare-dns';

type Call = { method: string; url: string; body?: Record<string, unknown> };

/** A fake Cloudflare zone holding `records`, recording every call made to it. */
function fakeZone(records: Array<Record<string, unknown>>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      calls.push({ method, url, body: init.body ? JSON.parse(String(init.body)) : undefined });
      const name = new URL(url).searchParams.get('name');
      const result = method === 'GET' ? records.filter((r) => r.name === name) : {};
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    })
  );
  return calls;
}

beforeEach(() => {
  mockEnv.env.CLOUDFLARE_API_TOKEN = 'token';
});
afterEach(() => vi.unstubAllGlobals());

describe('ensureAutoSubdomainRecord', () => {
  it('creates a proxied A record to the server, marked as ours', async () => {
    const calls = fakeZone([]);
    expect(await ensureAutoSubdomainRecord('shop.pushify.dev', '203.0.113.7')).toBe('created');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({ type: 'A', name: 'shop.pushify.dev', content: '203.0.113.7', proxied: true, comment: OUR_COMMENT });
  });

  it('moves its own record when the app moved servers, and leaves a correct one alone', async () => {
    const calls = fakeZone([{ id: 'r1', type: 'A', name: 'shop.pushify.dev', content: '198.51.100.1', proxied: true, comment: OUR_COMMENT }]);
    expect(await ensureAutoSubdomainRecord('shop.pushify.dev', '203.0.113.7')).toBe('updated');
    expect(calls.find((c) => c.method === 'PATCH')?.url).toContain('/dns_records/r1');

    fakeZone([{ id: 'r1', type: 'A', name: 'shop.pushify.dev', content: '203.0.113.7', proxied: true, comment: OUR_COMMENT }]);
    expect(await ensureAutoSubdomainRecord('shop.pushify.dev', '203.0.113.7')).toBe('unchanged');
  });

  it("never touches a record it didn't create — a project named api can't move api.pushify.dev", async () => {
    const calls = fakeZone([{ id: 'api', type: 'A', name: 'api.pushify.dev', content: '192.0.2.10', proxied: true, comment: null }]);
    expect(await ensureAutoSubdomainRecord('api.pushify.dev', '203.0.113.7')).toBe('foreign');
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('only manages names directly under the base domain', async () => {
    const calls = fakeZone([]);
    expect(await ensureAutoSubdomainRecord('pushify.dev', '203.0.113.7')).toBe('skipped');
    expect(await ensureAutoSubdomainRecord('a.b.pushify.dev', '203.0.113.7')).toBe('skipped');
    expect(await ensureAutoSubdomainRecord('shop.example.com', '203.0.113.7')).toBe('skipped');
    expect(calls).toEqual([]);
  });

  it('does nothing without Cloudflare credentials', async () => {
    mockEnv.env.CLOUDFLARE_API_TOKEN = undefined;
    const calls = fakeZone([]);
    expect(await ensureAutoSubdomainRecord('shop.pushify.dev', '203.0.113.7')).toBe('skipped');
    expect(calls).toEqual([]);
  });
});

describe('deleteAutoSubdomainRecord', () => {
  it('deletes only its own records', async () => {
    const calls = fakeZone([
      { id: 'ours', type: 'A', name: 'shop.pushify.dev', content: '203.0.113.7', comment: OUR_COMMENT },
      { id: 'theirs', type: 'TXT', name: 'shop.pushify.dev', content: 'verify', comment: 'added by hand' },
    ]);
    expect(await deleteAutoSubdomainRecord('shop.pushify.dev')).toBe(1);
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]).toContain('/dns_records/ours');
  });
});

describe('hostnameOf', () => {
  it('parses or returns null', () => {
    expect(hostnameOf('https://pr-3-shop.pushify.dev/')).toBe('pr-3-shop.pushify.dev');
    expect(hostnameOf('not a url')).toBeNull();
    expect(hostnameOf(null)).toBeNull();
  });
});
