import { Hono } from 'hono';
import { siteStudioService } from '../services/site-studio.service';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

const siteStudioRouter = new Hono<AppEnv>();

siteStudioRouter.get('/templates', async (c) => {
  const category = c.req.query('category');
  const search = c.req.query('search');
  const stack = c.req.query('stack');
  const templates = siteStudioService.getTemplates(category, search, stack);
  return c.json(templates);
});

siteStudioRouter.get('/stacks', async (c) => {
  return c.json({
    stacks: siteStudioService.getStacks(),
    summary: siteStudioService.getStackSummary(),
  });
});

siteStudioRouter.get('/templates/:templateId', async (c) => {
  const { templateId } = c.req.param();
  const template = siteStudioService.getTemplate(templateId);
  if (!template) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Site template not found' } }, 404);
  }
  return c.json(template);
});

siteStudioRouter.get('/categories', async (c) => {
  return c.json(siteStudioService.getCategories());
});

siteStudioRouter.use('/launch', authMiddleware);

siteStudioRouter.post('/launch', async (c) => {
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;
  const body = await c.req.json();

  const { siteTemplateId, serverId, name, domain, envVars } = body;

  if (!siteTemplateId || !serverId || !name) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'siteTemplateId, serverId, and name are required',
        },
      },
      400
    );
  }

  const locale = (c.get('locale') as 'en' | 'tr' | undefined) ?? 'en';

  try {
    const result = await siteStudioService.launch({
      organizationId,
      userId,
      siteTemplateId,
      serverId,
      name,
      domain,
      envVars: envVars || {},
      locale,
    });
    return c.json(result, 201);
  } catch (err: any) {
    return c.json(
      { error: { code: 'LAUNCH_FAILED', message: err.message } },
      400
    );
  }
});

export { siteStudioRouter as siteStudioRoutes };
