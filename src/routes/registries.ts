import { Hono } from 'hono';
import { registryCredentialService } from '../services/registry-credential.service';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

/**
 * Private container registries for the organization. The token is write-only: it goes in on
 * create and is never returned, only used on the deploy server.
 */
const registryRouter = new Hono<AppEnv>();

registryRouter.use('*', authMiddleware);

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
  const credential = await registryCredentialService.create(
    c.get('organizationId')!,
    c.get('userId')!,
    await c.req.json(),
    c.get('locale')
  );
  return c.json({ data: credential }, 201);
});

registryRouter.delete('/:id', async (c) => {
  const result = await registryCredentialService.remove(
    c.get('organizationId')!,
    c.get('userId')!,
    c.req.param('id'),
    c.get('locale')
  );
  return c.json({ data: result });
});

export { registryRouter as registryRoutes };
