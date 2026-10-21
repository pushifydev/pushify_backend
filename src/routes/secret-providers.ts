import { Hono } from 'hono';
import { rejectApiKeyAuth } from '../middleware/apikey-auth';
import { secretProviderService } from '../services/secret-provider.service';
import { activityService } from '../services/activity.service';
import { authMiddleware } from '../middleware/auth';
import { auditSource } from '../lib/audit';
import type { AppEnv } from '../types';

/**
 * External secret manager connections (Infisical, Doppler, Vault) for the organization or one of its projects.
 * The client secret / token is write-only: it goes in on create and is never returned.
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
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const connection = await secretProviderService.upsert(
    organizationId,
    userId,
    await c.req.json(),
    c.get('locale')
  );
  await activityService.logSecretProviderConnectionSaved(
    organizationId,
    userId,
    connection,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent'),
    auditSource(c)
  );
  return c.json({ data: connection }, 201);
});

secretProviderRouter.delete('/:id', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const { connection } = await secretProviderService.remove(
    organizationId,
    userId,
    c.req.param('id'),
    c.get('locale')
  );
  await activityService.logSecretProviderConnectionRemoved(
    organizationId,
    userId,
    connection,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent'),
    auditSource(c)
  );
  return c.json({ data: { success: true } });
});

export { secretProviderRouter as secretProviderRoutes };
