import { Hono } from 'hono';
import { rejectApiKeyAuth } from '../middleware/apikey-auth';
import { secretProviderService } from '../services/secret-provider.service';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

/**
 * External secret manager connections (Infisical) for the organization or one of its projects.
 * The client secret is write-only: it goes in on create and is never returned.
 */
const secretProviderRouter = new Hono<AppEnv>();

secretProviderRouter.use('*', authMiddleware);
// Secret manager credentials are managed from the dashboard only.
secretProviderRouter.use('*', rejectApiKeyAuth());

secretProviderRouter.get('/', async (c) => {
  const connections = await secretProviderService.list(
    c.get('organizationId')!,
    c.get('userId')!,
    c.get('locale')
  );
  return c.json({ data: connections });
});

// Connect a provider, or replace the connection stored for the same provider and scope
secretProviderRouter.post('/', async (c) => {
  const connection = await secretProviderService.upsert(
    c.get('organizationId')!,
    c.get('userId')!,
    await c.req.json(),
    c.get('locale')
  );
  return c.json({ data: connection }, 201);
});

secretProviderRouter.delete('/:id', async (c) => {
  const result = await secretProviderService.remove(
    c.get('organizationId')!,
    c.get('userId')!,
    c.req.param('id'),
    c.get('locale')
  );
  return c.json({ data: result });
});

export { secretProviderRouter as secretProviderRoutes };
