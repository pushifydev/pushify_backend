import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';

vi.mock('../db', () => ({ db: {} }));
vi.mock('../lib/ssrf-guard', async (importOriginal) => ({ ...(await importOriginal<object>()), assertPublicUrl: async () => {} }));

import { notificationService, signWebhookBody } from './notification.service';

/** What the docs tell receivers to do, in Node. */
function verify(rawBody: string, header: string | null, secret: string): boolean {
  if (!header?.startsWith('sha256=')) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'));
  const given = Buffer.from(header.slice('sha256='.length));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

describe('webhook signatures', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('signs exactly the bytes that are sent', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const ok = await notificationService.sendWebhookNotification(
      { url: 'https://hooks.example.com/pushify', secret: 'whsec_test' },
      { event: 'deployment.success', projectId: 'p1', projectName: 'app' } as never,
    );
    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    const body = init.body as string;
    expect(JSON.parse(body)).toMatchObject({ event: 'deployment.success', data: { projectId: 'p1' } });
    expect(verify(body, init.headers['X-Pushify-Signature'], 'whsec_test')).toBe(true);
    expect(verify(body, init.headers['X-Pushify-Signature'], 'wrong')).toBe(false);
  });

  it('sends no signature without a secret', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await notificationService.sendWebhookNotification({ url: 'https://hooks.example.com/x' } as never, { event: 'health.recovered' } as never);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(init.headers['X-Pushify-Signature']).toBeUndefined();
  });

  it('is the documented format', () => {
    expect(signWebhookBody('k', '{}')).toBe(`sha256=${createHmac('sha256', 'k').update('{}').digest('hex')}`);
  });
});
