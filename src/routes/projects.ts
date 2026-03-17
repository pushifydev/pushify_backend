import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { projectService } from '../services/project.service';
import { activityService } from '../services/activity.service';
import { combinedAuthMiddleware } from '../middleware/auth';
import { requireScope } from '../middleware/apikey-auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

// ============ Schemas ============

const ProjectServerSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    ipv4: z.string().nullable(),
    status: z.string(),
    setupStatus: z.string(),
  })
  .openapi('ProjectServer');

const ProjectSchema = z
  .object({
    id: z.string(),
    organizationId: z.string(),
    name: z.string(),
    slug: z.string(),
    description: z.string().nullable(),
    gitRepoUrl: z.string().nullable(),
    gitBranch: z.string().nullable(),
    gitProvider: z.string().nullable(),
    buildCommand: z.string().nullable(),
    startCommand: z.string().nullable(),
    rootDirectory: z.string().nullable(),
    dockerfilePath: z.string().nullable(),
    port: z.number().nullable(),
    autoDeploy: z.boolean(),
    status: z.enum(['active', 'paused', 'deleted']),
    serverId: z.string().nullable(),
    server: ProjectServerSchema.optional(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .openapi('Project');

const ProjectWithDomainsSchema = ProjectSchema.extend({
  domains: z.array(
    z.object({
      id: z.string(),
      domain: z.string(),
      isPrimary: z.boolean(),
      sslStatus: z.string().nullable(),
    })
  ),
}).openapi('ProjectWithDomains');

const ProjectListItemSchema = ProjectSchema.extend({
  domains: z.array(
    z.object({
      id: z.string(),
      domain: z.string(),
      isPrimary: z.boolean(),
    })
  ),
}).openapi('ProjectListItem');

const MessageSchema = z
  .object({
    message: z.string(),
  })
  .openapi('Message');

// ============ Request Schemas ============

const CreateProjectSchema = z
  .object({
    name: z.string().min(1).max(255).openapi({ example: 'My App' }),
    description: z.string().max(1000).optional().openapi({ example: 'A sample application' }),
    gitRepoUrl: z.string().url().optional().openapi({ example: 'https://github.com/user/repo' }),
    gitBranch: z.string().max(100).optional().openapi({ example: 'main' }),
    gitProvider: z.enum(['github', 'gitlab', 'bitbucket']).optional(),
    buildCommand: z.string().max(500).optional().openapi({ example: 'npm run build' }),
    startCommand: z.string().max(500).optional().openapi({ example: 'npm start' }),
    rootDirectory: z.string().max(255).optional().openapi({ example: '/' }),
    dockerfilePath: z.string().max(255).optional().openapi({ example: 'Dockerfile' }),
    port: z.number().int().min(1).max(65535).optional().openapi({ example: 3000 }),
    autoDeploy: z.boolean().optional().openapi({ example: true }),
    serverId: z.string().uuid().optional().openapi({ example: '123e4567-e89b-12d3-a456-426614174000' }),
  })
  .openapi('CreateProject');

const UpdateProjectSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).optional(),
    gitRepoUrl: z.string().url().optional(),
    gitBranch: z.string().max(100).optional(),
    gitProvider: z.enum(['github', 'gitlab', 'bitbucket']).optional(),
    buildCommand: z.string().max(500).optional(),
    startCommand: z.string().max(500).optional(),
    rootDirectory: z.string().max(255).optional(),
    dockerfilePath: z.string().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    autoDeploy: z.boolean().optional(),
    serverId: z.string().uuid().nullable().optional(),
  })
  .openapi('UpdateProject');

const UpdateStatusSchema = z
  .object({
    status: z.enum(['active', 'paused']),
  })
  .openapi('UpdateStatus');

// ============ Route Definitions ============

const listProjectsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Projects'],
  summary: 'List all projects',
  description: 'Get all projects for the current organization',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'List of projects',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(ProjectListItemSchema),
          }),
        },
      },
    },
  },
});

const createProjectRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Projects'],
  summary: 'Create a new project',
  description: 'Create a new project in the current organization',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: CreateProjectSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Project created successfully',
      content: {
        'application/json': {
          schema: z.object({
            data: ProjectSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const getProjectRoute = createRoute({
  method: 'get',
  path: '/{projectId}',
  tags: ['Projects'],
  summary: 'Get project details',
  description: 'Get detailed information about a specific project',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Project details',
      content: {
        'application/json': {
          schema: z.object({
            data: ProjectWithDomainsSchema,
          }),
        },
      },
    },
  },
});

const updateProjectRoute = createRoute({
  method: 'patch',
  path: '/{projectId}',
  tags: ['Projects'],
  summary: 'Update project',
  description: 'Update project configuration',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: UpdateProjectSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Project updated successfully',
      content: {
        'application/json': {
          schema: z.object({
            data: ProjectSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const deleteProjectRoute = createRoute({
  method: 'delete',
  path: '/{projectId}',
  tags: ['Projects'],
  summary: 'Delete project',
  description: 'Delete a project (soft delete)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Project deleted successfully',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

const updateStatusRoute = createRoute({
  method: 'patch',
  path: '/{projectId}/status',
  tags: ['Projects'],
  summary: 'Update project status',
  description: 'Pause or resume a project',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: UpdateStatusSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Status updated successfully',
      content: {
        'application/json': {
          schema: z.object({
            data: ProjectSchema,
          }),
        },
      },
    },
  },
});

// ============ Router ============

const projectRouter = new OpenAPIHono<AppEnv>();

// All routes require authentication (supports both JWT and API key)
projectRouter.use('*', combinedAuthMiddleware);

// Scope requirements for API key access
projectRouter.get('/', requireScope('projects:read'));
projectRouter.get('/:projectId', requireScope('projects:read'));
projectRouter.post('/', requireScope('projects:write'));
projectRouter.patch('/:projectId', requireScope('projects:write'));
projectRouter.delete('/:projectId', requireScope('projects:write'));
projectRouter.patch('/:projectId/status', requireScope('projects:write'));
projectRouter.get('/:projectId/webhook', requireScope('projects:read'));
projectRouter.post('/:projectId/webhook/regenerate', requireScope('projects:write'));
projectRouter.patch('/:projectId/settings', requireScope('projects:write'));

// List projects
projectRouter.openapi(listProjectsRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const projects = await projectService.getByOrganization(organizationId, userId, locale);

  return c.json({ data: projects });
});

// Create project
projectRouter.openapi(createProjectRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const input = c.req.valid('json');

  const project = await projectService.create(organizationId, userId, input, locale);

  // Log activity
  await activityService.logProjectCreated(
    organizationId,
    userId,
    project.id,
    project.name,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent')
  );

  return c.json(
    {
      data: project,
      message: t(locale, 'projects', 'created'),
    },
    201
  );
});

// Get project
projectRouter.openapi(getProjectRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');

  const project = await projectService.getById(projectId, organizationId, userId, locale);

  // Transform server to match schema (pick only required fields)
  const responseData = {
    ...project,
    server: project.server
      ? {
          id: project.server.id,
          name: project.server.name,
          ipv4: project.server.ipv4,
          status: project.server.status,
          setupStatus: project.server.setupStatus,
        }
      : undefined,
  };

  return c.json({ data: responseData });
});

// Update project
projectRouter.openapi(updateProjectRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const input = c.req.valid('json');

  const project = await projectService.update(projectId, organizationId, userId, input, locale);

  // Log activity
  await activityService.logProjectUpdated(
    organizationId,
    userId,
    projectId,
    project.name,
    input,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent')
  );

  return c.json({
    data: project,
    message: t(locale, 'projects', 'updated'),
  });
});

// Delete project
projectRouter.openapi(deleteProjectRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');

  // Get project name before deleting
  const project = await projectService.getById(projectId, organizationId, userId, locale);

  await projectService.delete(projectId, organizationId, userId, locale);

  // Log activity
  await activityService.logProjectDeleted(
    organizationId,
    userId,
    projectId,
    project.name,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent')
  );

  return c.json({ message: t(locale, 'projects', 'deleted') });
});

// Update status
projectRouter.openapi(updateStatusRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const { status } = c.req.valid('json');

  const project = await projectService.updateStatus(projectId, organizationId, userId, status, locale);

  // Log activity
  const action = status === 'paused' ? 'project.paused' : 'project.resumed';
  await activityService.log({
    organizationId,
    userId,
    projectId,
    action: action as any,
    description: status === 'paused' ? `Paused project "${project.name}"` : `Resumed project "${project.name}"`,
    metadata: { status },
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({ data: project });
});

// ============ Webhook Management ============

// Get webhook info
projectRouter.get('/:projectId/webhook', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId') as string;

  const project = await projectService.getById(projectId, organizationId, userId, locale);

  const baseUrl = process.env.API_BASE_URL || 'http://localhost:4000';
  const webhookUrl = `${baseUrl}/api/v1/webhooks/github/${project.id}`;

  return c.json({
    data: {
      webhookUrl,
      hasSecret: !!project.webhookSecret,
      autoDeploy: project.autoDeploy,
    },
  });
});

// Generate/Regenerate webhook secret
projectRouter.post('/:projectId/webhook/regenerate', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId') as string;

  const { secret } = await projectService.regenerateWebhookSecret(projectId, organizationId, userId, locale);

  // Log activity
  await activityService.log({
    organizationId,
    userId,
    projectId,
    action: 'webhook.regenerated',
    description: 'Regenerated webhook secret',
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({
    data: { secret },
    message: t(locale, 'projects', 'webhookRegenerated'),
  });
});

// ============ Settings Management ============

// Update project settings
projectRouter.patch('/:projectId/settings', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId') as string;
  const settings = await c.req.json();

  const project = await projectService.updateSettings(projectId, organizationId, userId, settings, locale);

  // Log activity
  const changedSettings = Object.keys(settings).join(', ');
  await activityService.logSettingsUpdated(
    organizationId,
    userId,
    projectId,
    changedSettings,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent')
  );

  return c.json({
    data: project,
    message: t(locale, 'projects', 'settingsUpdated'),
  });
});

export { projectRouter as projectRoutes };
