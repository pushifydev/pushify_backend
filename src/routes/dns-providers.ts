import { Hono } from 'hono';
import { rejectApiKeyAuth } from '../middleware/apikey-auth';
import { dnsProviderService } from '../services/dns-provider.service';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

/**
 * The organization's Cloudflare connection, used to create DNS records when a custom domain is
 * added. The API token is write-only: only a masked hint is ever returned.
 */
const dnsProviderRouter = new Hono<AppEnv>();

dnsProviderRouter.use('*', authMiddleware);
// DNS credentials are managed from the dashboard only.
dnsProviderRouter.use('*', rejectApiKeyAuth());

dnsProviderRouter.get('/cloudflare', async (c) => {
  const data = await dnsProviderService.getCloudflare(c.get('organizationId')!, c.get('userId')!, c.get('locale'));
  return c.json({ data });
});

dnsProviderRouter.put('/cloudflare', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const data = await dnsProviderService.setCloudflare(c.get('organizationId')!, c.get('userId')!, body, c.get('locale'));
  return c.json({ data });
});

dnsProviderRouter.delete('/cloudflare', async (c) => {
  const data = await dnsProviderService.removeCloudflare(c.get('organizationId')!, c.get('userId')!, c.get('locale'));
  return c.json({ data });
});

export { dnsProviderRouter as dnsProviderRoutes };
