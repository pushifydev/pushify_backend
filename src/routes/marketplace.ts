import { Hono } from 'hono';
import { marketplaceService } from '../services/marketplace.service';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

const marketplaceRouter = new Hono<AppEnv>();

// Public routes - template listing
marketplaceRouter.get('/templates', async (c) => {
  const category = c.req.query('category');
  const search = c.req.query('search');
  const templates = marketplaceService.getTemplates(category, search);
  return c.json(templates);
});

marketplaceRouter.get('/templates/:templateId', async (c) => {
  const { templateId } = c.req.param();
  const template = marketplaceService.getTemplate(templateId);
  if (!template) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Template not found' } }, 404);
  }
  return c.json(template);
});

// Protected routes - deployment
marketplaceRouter.use('/deploy', authMiddleware);
marketplaceRouter.use('/deployments', authMiddleware);

marketplaceRouter.post('/deploy', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const body = await c.req.json();

  const { templateId, serverId, name, envVars, domain } = body;

  if (!templateId || !serverId || !name) {
    return c.json(
      { error: { code: 'VALIDATION_ERROR', message: 'templateId, serverId, and name are required' } },
      400
    );
  }

  try {
    const result = await marketplaceService.deploy({
      organizationId,
      userId,
      templateId,
      serverId,
      name,
      envVars: envVars || {},
      domain,
    });
    return c.json(result, 201);
  } catch (err: any) {
    return c.json(
      { error: { code: 'DEPLOY_FAILED', message: err.message } },
      400
    );
  }
});

marketplaceRouter.get('/deployments', async (c) => {
  const organizationId = c.get('organizationId')!;
  const deployments = await marketplaceService.getDeployments(organizationId);
  return c.json(deployments);
});

export { marketplaceRouter as marketplaceRoutes };
