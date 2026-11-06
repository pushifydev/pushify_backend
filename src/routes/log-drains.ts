import { Hono } from 'hono';
import { rejectApiKeyAuth } from '../middleware/apikey-auth';
import { authMiddleware } from '../middleware/auth';
import { logDrainService } from '../services/log-drain.service';
import type { AppEnv } from '../types';

/**
 * Log and metric drains for the organization or one of its projects (lib/log-drains.ts).
 * The secret is write-only: it goes in on create / update and is never returned.
 */
const logDrainRouter = new Hono<AppEnv>();

logDrainRouter.use('*', authMiddleware);
// Drain credentials are managed from the dashboard only.
logDrainRouter.use('*', rejectApiKeyAuth());

const readJson = async (c: { req: { json: () => Promise<unknown> } }) => c.req.json().catch(() => null);

logDrainRouter.get('/', async (c) => {
  const drains = await logDrainService.list(c.get('organizationId')!, c.get('userId')!, c.get('locale'));
  return c.json({ data: drains });
});

logDrainRouter.post('/', async (c) => {
  const drain = await logDrainService.create(
    c.get('organizationId')!,
    c.get('userId')!,
    (await readJson(c)) as never,
    c.get('locale')
  );
  return c.json({ data: drain }, 201);
});

// Re-apply the agent on every server of the organization and wait for the outcome
logDrainRouter.post('/sync', async (c) => {
  const results = await logDrainService.syncForUser(c.get('organizationId')!, c.get('userId')!, c.get('locale'));
  return c.json({ data: results });
});

logDrainRouter.patch('/:id', async (c) => {
  const drain = await logDrainService.update(
    c.get('organizationId')!,
    c.get('userId')!,
    c.req.param('id'),
    (await readJson(c)) as never,
    c.get('locale')
  );
  return c.json({ data: drain });
});

logDrainRouter.delete('/:id', async (c) => {
  const result = await logDrainService.remove(c.get('organizationId')!, c.get('userId')!, c.req.param('id'), c.get('locale'));
  return c.json({ data: result });
});

// Send one test event to the drain from the API
logDrainRouter.post('/:id/test', async (c) => {
  const result = await logDrainService.test(c.get('organizationId')!, c.get('userId')!, c.req.param('id'), c.get('locale'));
  return c.json({ data: result });
});

export { logDrainRouter as logDrainRoutes };
