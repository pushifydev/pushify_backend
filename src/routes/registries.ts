import { Hono } from 'hono';
import { rejectApiKeyAuth } from '../middleware/apikey-auth';
import { registryCredentialService } from '../services/registry-credential.service';
import { activityService } from '../services/activity.service';
import { authMiddleware } from '../middleware/auth';
import { auditSource } from '../lib/audit';
import type { AppEnv } from '../types';

/**
 * Private container registries for the organization. The token is write-only: it goes in on
 * create and is never returned, only used on the deploy server.
 */
const registryRouter = new Hono<AppEnv>();

registryRouter.use('*', authMiddleware);
// Registry passwords are managed from the dashboard only.
registryRouter.use('*', rejectApiKeyAuth());

registryRouter.get('/', async (c) => {
  const credentials = await registryCredentialService.list(
    c.get('organizationId')!,
    c.get('userId')!,
    c.get('locale')
  );
  return c.json({ data: credentials });
});

// Add a registry, or replace the credentials stored for one
registryRouter.post('/', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const credential = await registryCredentialService.create(
    organizationId,
    userId,
    await c.req.json(),
    c.get('locale')
  );
  await activityService.logRegistryCredentialSaved(
    organizationId,
    userId,
    credential,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent'),
    auditSource(c)
  );
  return c.json({ data: credential }, 201);
});

registryRouter.delete('/:id', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const { credential } = await registryCredentialService.remove(
    organizationId,
    userId,
    c.req.param('id'),
    c.get('locale')
  );
  await activityService.logRegistryCredentialRemoved(
    organizationId,
    userId,
    credential,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent'),
    auditSource(c)
  );
  return c.json({ data: { success: true } });
});

export { registryRouter as registryRoutes };
