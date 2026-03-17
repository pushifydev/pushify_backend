import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { apiKeyService } from '../services/apikey.service';
import { activityService } from '../services/activity.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import { API_KEY_SCOPES } from '../db/schema';
import type { AppEnv } from '../types';

const apiKeyRouter = new Hono<AppEnv>();

// All routes require authentication (JWT only - not API key)
apiKeyRouter.use('*', authMiddleware);

// Validation schemas
const createApiKeySchema = z.object({
  name: z.string().min(1).max(255),
  scopes: z.array(z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
});

const updateApiKeySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  scopes: z.array(z.string()).optional(),
});

// Get all API keys for the current user
apiKeyRouter.get('/', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const keys = await apiKeyService.list(userId, organizationId, locale);

  return c.json({ data: keys });
});

// Get available scopes
apiKeyRouter.get('/scopes', async (c) => {
  const scopes = apiKeyService.getAvailableScopes();
  return c.json({ data: scopes });
});

// Create a new API key
apiKeyRouter.post('/', zValidator('json', createApiKeySchema), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = c.req.valid('json');

  const apiKey = await apiKeyService.create(
    userId,
    organizationId,
    {
      name: body.name,
      scopes: body.scopes,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
    },
    locale
  );

  // Log activity
  await activityService.logApiKeyCreated(
    organizationId,
    userId,
    body.name,
    apiKey.prefix,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent')
  );

  return c.json(
    {
      data: apiKey,
      message: t(locale, 'apiKeys', 'created'),
    },
    201
  );
});

// Update an API key
apiKeyRouter.patch('/:keyId', zValidator('json', updateApiKeySchema), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const keyId = c.req.param('keyId');
  const body = c.req.valid('json');

  const apiKey = await apiKeyService.update(
    keyId,
    userId,
    organizationId,
    {
      name: body.name,
      scopes: body.scopes,
    },
    locale
  );

  return c.json({
    data: apiKey,
    message: t(locale, 'apiKeys', 'updated'),
  });
});

// Revoke an API key
apiKeyRouter.delete('/:keyId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const keyId = c.req.param('keyId');

  // Get key name before revoking
  const keys = await apiKeyService.list(userId, organizationId, locale);
  const key = keys.find(k => k.id === keyId);

  await apiKeyService.revoke(keyId, userId, organizationId, locale);

  // Log activity
  if (key) {
    await activityService.logApiKeyRevoked(
      organizationId,
      userId,
      key.name,
      c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
      c.req.header('user-agent')
    );
  }

  return c.json({ message: t(locale, 'apiKeys', 'revoked') });
});

// Get all API keys for the organization (admin only)
apiKeyRouter.get('/organization', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const keys = await apiKeyService.listOrganizationKeys(userId, organizationId, locale);

  return c.json({ data: keys });
});

export { apiKeyRouter as apiKeyRoutes };
