import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { assertOrganizationCanMutateResources } from '../services/organization-billing.service';
import { requireOrgMember } from '../lib/org-access';
import { siteStudioService } from '../services/site-studio.service';
import { authMiddleware } from '../middleware/auth';
import { requireScope } from '../middleware/apikey-auth';
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

// Creates a project and starts a deploy: an API key needs projects:write.
siteStudioRouter.post('/launch', requireScope('projects:write'), async (c) => {
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

  // Launching creates and deploys a project: member and up, and not while the organization is locked.
  await requireOrgMember(organizationId, userId, 'member', locale);
  await assertOrganizationCanMutateResources(organizationId, locale);

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
    // Plan quota (403) and other intentional errors keep their status.
    if (err instanceof HTTPException) throw err;
    return c.json(
      { error: { code: 'LAUNCH_FAILED', message: err.message } },
      400
    );
  }
});

export { siteStudioRouter as siteStudioRoutes };
