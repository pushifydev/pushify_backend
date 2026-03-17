import { Hono } from 'hono';
import { serverService } from '../services/server.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';
import type { ProviderType } from '../providers';

const serverRouter = new Hono<AppEnv>();

// All routes require authentication
serverRouter.use('*', authMiddleware);

// ============ Provider Routes ============
// IMPORTANT: These must be defined BEFORE :serverId routes to avoid matching conflicts

// Get available regions for a provider
serverRouter.get('/providers/:provider/regions', async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;

  const regions = await serverService.getRegions(provider, locale);

  return c.json({ data: regions });
});

// Get available images for a provider
serverRouter.get('/providers/:provider/images', async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;

  const images = await serverService.getImages(provider, locale);

  return c.json({ data: images });
});

// Get available sizes for a provider
serverRouter.get('/providers/:provider/sizes', async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;

  const sizes = await serverService.getSizes(provider, locale);

  return c.json({ data: sizes });
});

// Get available server types for a provider (raw types from provider)
serverRouter.get('/providers/:provider/server-types', async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;
  const location = c.req.query('location');

  const serverTypes = await serverService.getServerTypes(provider, location, locale);

  return c.json({ data: serverTypes });
});

// ============ Server Routes ============

// List all servers
serverRouter.get('/', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const servers = await serverService.listServers(organizationId, userId, locale);

  return c.json({ data: servers });
});

// Create a new server
serverRouter.post('/', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const server = await serverService.createServer(organizationId, userId, body, locale);

  return c.json({ data: server }, 201);
});

// Get a single server
serverRouter.get('/:serverId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.getServer(serverId, organizationId, userId, locale);

  return c.json({ data: server });
});

// Delete a server
serverRouter.delete('/:serverId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  await serverService.deleteServer(serverId, organizationId, userId, locale);

  return c.json({ message: t(locale, 'servers', 'deleted') });
});

// Power actions
serverRouter.post('/:serverId/start', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.powerAction(serverId, organizationId, userId, 'start', locale);

  return c.json({ data: server, message: t(locale, 'servers', 'started') });
});

serverRouter.post('/:serverId/stop', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.powerAction(serverId, organizationId, userId, 'stop', locale);

  return c.json({ data: server, message: t(locale, 'servers', 'stopped') });
});

serverRouter.post('/:serverId/reboot', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.powerAction(serverId, organizationId, userId, 'reboot', locale);

  return c.json({ data: server, message: t(locale, 'servers', 'rebooted') });
});

// Sync server status from provider
serverRouter.post('/:serverId/sync', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.syncServer(serverId, organizationId, userId, locale);

  return c.json({ data: server });
});

export { serverRouter as serverRoutes };
