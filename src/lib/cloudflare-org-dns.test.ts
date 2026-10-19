import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CloudflareDnsError,
  createCustomDomainRecords,
  deleteCustomDomainRecords,
  maskToken,
  syncCustomDomainRecords,
  verifyCloudflareToken,
  zoneCandidates,
  ORG_RECORD_COMMENT,
} from './cloudflare-org-dns';

const TOKEN = 'cf-secret-token-0123456789';

type Call = { method: string; url: string; auth?: string; body?: Record<string, unknown> };

/** A fake Cloudflare API with the given zones and records. */
function fakeCloudflare(
  opts: {
    zones?: string[];
    records?: Array<{ id?: string; type: string; name: string; content?: string; comment?: string; proxied?: boolean }>;
    status?: number;
  } = {}
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method || 'GET';
      const headers = (init.headers || {}) as Record<string, string>;
      calls.push({ method, url, auth: headers.Authorization, body: init.body ? JSON.parse(String(init.body)) : undefined });
      if (opts.status) {
        return new Response(JSON.stringify({ success: false, errors: [{ message: 'Invalid API Token' }] }), { status: opts.status });
      }
      const u = new URL(url);
      let result: unknown = {};
      if (u.pathname.endsWith('/user/tokens/verify')) result = { status: 'active' };
      else if (u.pathname.endsWith('/zones')) {
        const name = u.searchParams.get('name');
        result = (opts.zones || []).filter((z) => z === name).map((z) => ({ id: `zone-${z}`, name: z }));
      } else if (u.pathname.endsWith('/dns_records') && method === 'GET') {
        result = (opts.records || []).filter((r) => r.type === u.searchParams.get('type') && r.name === u.searchParams.get('name'));
      } else if (method === 'POST') {
        const body = JSON.parse(String(init.body));
        result = { id: `rec-${body.type}`, proxied: body.proxied };
      }
      return new Response(JSON.stringify({ success: true, result }), { status: 200 });
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('maskToken', () => {
  it('never shows the whole token', () => {
    expect(maskToken(TOKEN)).toBe('cf-s…6789');
    expect(maskToken('short')).toBe('****');
    expect(maskToken(null)).toBe('');
  });
});

describe('zoneCandidates', () => {
  it('walks from the full name up to the registrable part', () => {
    expect(zoneCandidates('a.b.example.com')).toEqual(['a.b.example.com', 'b.example.com', 'example.com']);
  });
});

describe('createCustomDomainRecords', () => {
  it('creates A and AAAA records in the matching zone, unproxied by default', async () => {
    const calls = fakeCloudflare({ zones: ['example.com'] });
    const result = await createCustomDomainRecords(TOKEN, { domain: 'App.Example.com', ipv4: '203.0.113.7', ipv6: '2001:db8::7' });
    expect(result.zone).toBe('example.com');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].url).toContain('/zones/zone-example.com/dns_records');
    expect(posts[0].body).toMatchObject({ type: 'A', name: 'app.example.com', content: '203.0.113.7', proxied: false, comment: ORG_RECORD_COMMENT });
    expect(posts[1].body).toMatchObject({ type: 'AAAA', content: '2001:db8::7', proxied: false });
    expect(calls.every((c) => c.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('applies the proxy flag when asked', async () => {
    const calls = fakeCloudflare({ zones: ['example.com'] });
    const result = await createCustomDomainRecords(TOKEN, { domain: 'example.com', ipv4: '203.0.113.7', proxied: true });
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ type: 'A', proxied: true });
    expect(result.records).toEqual([{ id: 'rec-A', type: 'A', content: '203.0.113.7', proxied: true }]);
  });

  it('leaves an existing record alone and creates nothing', async () => {
    const calls = fakeCloudflare({ zones: ['example.com'], records: [{ type: 'AAAA', name: 'app.example.com' }] });
    await expect(
      createCustomDomainRecords(TOKEN, { domain: 'app.example.com', ipv4: '203.0.113.7', ipv6: '2001:db8::7' })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(calls.filter((c) => c.method === 'POST')).toEqual([]);
  });

  it('reports a domain whose zone the token cannot see', async () => {
    fakeCloudflare({ zones: ['other.com'] });
    await expect(createCustomDomainRecords(TOKEN, { domain: 'app.example.com', ipv4: '203.0.113.7' })).rejects.toMatchObject({
      code: 'zone_not_found',
    });
  });

  it('turns a rejected token into a clear error that does not contain the token', async () => {
    fakeCloudflare({ status: 403 });
    const err = await createCustomDomainRecords(TOKEN, { domain: 'app.example.com', ipv4: '203.0.113.7' }).catch((e) => e);
    expect(err).toBeInstanceOf(CloudflareDnsError);
    expect(err.code).toBe('invalid_token');
    expect(err.message).toContain('Invalid API Token');
    expect(err.message).toContain('DNS: Edit');
    expect(err.message).not.toContain(TOKEN);
  });
});

describe('deleteCustomDomainRecords', () => {
  it("deletes only the A/AAAA records Pushify created, leaving others' records alone", async () => {
    const calls = fakeCloudflare({
      zones: ['example.com'],
      records: [
        { id: 'ours-a', type: 'A', name: 'app.example.com', comment: ORG_RECORD_COMMENT },
        { id: 'ours-aaaa', type: 'AAAA', name: 'app.example.com', comment: ORG_RECORD_COMMENT },
        { id: 'theirs', type: 'A', name: 'app.example.com', comment: 'set by hand' },
      ],
    });
    expect(await deleteCustomDomainRecords(TOKEN, 'App.Example.com')).toBe(2);
    const deletes = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deletes).toEqual([
      expect.stringContaining('/zones/zone-example.com/dns_records/ours-a'),
      expect.stringContaining('/zones/zone-example.com/dns_records/ours-aaaa'),
    ]);
  });

  it('does nothing when the token cannot see the zone', async () => {
    const calls = fakeCloudflare({ zones: ['other.com'] });
    expect(await deleteCustomDomainRecords(TOKEN, 'app.example.com')).toBe(0);
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([]);
  });
});

describe('syncCustomDomainRecords', () => {
  const rec = (id: string, type: string, content: string, comment = ORG_RECORD_COMMENT, proxied = false) => ({
    id,
    type,
    name: 'app.example.com',
    content,
    comment,
    proxied,
  });

  it("re-points only Pushify's records to the new IPv4/IPv6, keeping hand-made ones", async () => {
    const calls = fakeCloudflare({
      zones: ['example.com'],
      records: [
        rec('ours-a', 'A', '203.0.113.7'),
        rec('ours-aaaa', 'AAAA', '2001:db8::7'),
        rec('theirs', 'A', '198.51.100.1', 'set by hand'),
      ],
    });
    const result = await syncCustomDomainRecords(TOKEN, { domain: 'App.Example.com', ipv4: '203.0.113.9', ipv6: '2001:db8::9' });
    expect(result).toEqual({ updated: 2, created: 0, deleted: 0 });
    const patches = calls.filter((c) => c.method === 'PATCH');
    expect(patches.map((c) => c.url)).toEqual([
      expect.stringContaining('/dns_records/ours-a'),
      expect.stringContaining('/dns_records/ours-aaaa'),
    ]);
    expect(patches[0].body).toEqual({ content: '203.0.113.9' });
    expect(patches[1].body).toEqual({ content: '2001:db8::9' });
  });

  it('changes nothing when the records already point at the server', async () => {
    const calls = fakeCloudflare({ zones: ['example.com'], records: [rec('ours-a', 'A', '203.0.113.7')] });
    expect(await syncCustomDomainRecords(TOKEN, { domain: 'app.example.com', ipv4: '203.0.113.7' })).toEqual({
      updated: 0,
      created: 0,
      deleted: 0,
    });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('leaves a domain alone when Pushify created none of its records', async () => {
    const calls = fakeCloudflare({ zones: ['example.com'], records: [rec('theirs', 'A', '198.51.100.1', '')] });
    await syncCustomDomainRecords(TOKEN, { domain: 'app.example.com', ipv4: '203.0.113.9', ipv6: '2001:db8::9' });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('adds an AAAA record (same proxy mode) for a new IPv6 and drops ours when IPv6 goes away', async () => {
    let calls = fakeCloudflare({ zones: ['example.com'], records: [rec('ours-a', 'A', '203.0.113.7', ORG_RECORD_COMMENT, true)] });
    expect(await syncCustomDomainRecords(TOKEN, { domain: 'app.example.com', ipv4: '203.0.113.7', ipv6: '2001:db8::9' })).toMatchObject({
      created: 1,
    });
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({
      type: 'AAAA',
      content: '2001:db8::9',
      proxied: true,
      comment: ORG_RECORD_COMMENT,
    });

    calls = fakeCloudflare({
      zones: ['example.com'],
      records: [rec('ours-a', 'A', '203.0.113.7'), rec('ours-aaaa', 'AAAA', '2001:db8::7')],
    });
    expect(await syncCustomDomainRecords(TOKEN, { domain: 'app.example.com', ipv4: '203.0.113.7', ipv6: null })).toMatchObject({
      deleted: 1,
    });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url)).toEqual([expect.stringContaining('/dns_records/ours-aaaa')]);
  });

  it('does not create an AAAA record next to a hand-made one', async () => {
    const calls = fakeCloudflare({
      zones: ['example.com'],
      records: [rec('ours-a', 'A', '203.0.113.7'), rec('theirs', 'AAAA', '2001:db8::1', '')],
    });
    await syncCustomDomainRecords(TOKEN, { domain: 'app.example.com', ipv4: '203.0.113.7', ipv6: '2001:db8::9' });
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('does nothing for a server without any address', async () => {
    const calls = fakeCloudflare({ zones: ['example.com'], records: [rec('ours-a', 'A', '203.0.113.7')] });
    await syncCustomDomainRecords(TOKEN, { domain: 'app.example.com', ipv4: null, ipv6: null });
    expect(calls).toEqual([]);
  });
});

describe('verifyCloudflareToken', () => {
  it('is true for an active token and false for a rejected one', async () => {
    fakeCloudflare();
    expect(await verifyCloudflareToken(TOKEN)).toBe(true);
    fakeCloudflare({ status: 401 });
    expect(await verifyCloudflareToken(TOKEN)).toBe(false);
  });
});
