import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../db', () => ({ db: {} }));

import {
  sendSlackNotification,
  sendDiscordNotification,
  sendWebhookNotification,
} from './notification.worker';

const payload = { event: 'deployment.success', projectId: 'p1', projectName: 'app' } as never;

// The real SSRF guard runs here; IP-literal URLs keep it off DNS.
const senders = [
  ['slack', (url: string) => sendSlackNotification({ webhookUrl: url }, payload)],
  ['discord', (url: string) => sendDiscordNotification({ webhookUrl: url }, payload)],
  ['webhook', (url: string) => sendWebhookNotification({ url, secret: 'whsec_test' }, payload)],
] as const;

describe('notification worker SSRF guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe.each(senders)('%s', (_type, send) => {
    it.each([
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.1:6379/',
      'http://10.0.0.5/hook',
      'http://[::1]/hook',
    ])('refuses %s without making a request', async (url) => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(send(url)).rejects.toThrow('Blocked private/internal address');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('does not follow a redirect from a public URL', async () => {
      const fetchMock = vi.fn(
        async () =>
          new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest/meta-data/' } }),
      );
      vi.stubGlobal('fetch', fetchMock);

      expect(await send('https://93.184.216.34/hook')).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [target, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      expect(target).toBe('https://93.184.216.34/hook');
      expect(init.redirect).toBe('manual');
    });

    it('still delivers to a public URL', async () => {
      const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      expect(await send('https://93.184.216.34/hook')).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
