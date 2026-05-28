import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { envVarService } from '../services/envvar.service';
import { activityService } from '../services/activity.service';
import { combinedAuthMiddleware } from '../middleware/auth';
import { requireScope } from '../middleware/apikey-auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

// ============ Schemas ============

const EnvironmentEnum = z.enum(['production', 'staging', 'development', 'preview']);

const EnvVarSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    environment: EnvironmentEnum,
    key: z.string(),
    value: z.string(),
    isSecret: z.boolean(),
    createdAt: z.coerce.date(),
    updatedAt: z.coerce.date(),
  })
  .openapi('EnvVar');

const BulkResultSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    environment: z.string(),
    isSecret: z.boolean(),
    action: z.enum(['created', 'updated']),
  })
  .openapi('BulkResult');

const MessageSchema = z
  .object({
    message: z.string(),
  })
  .openapi('EnvVarMessage');

// ============ Request Schemas ============

const CreateEnvVarSchema = z
  .object({
    key: z.string().min(1).max(255).openapi({ example: 'DATABASE_URL' }),
    value: z.string().min(1).openapi({ example: 'postgres://localhost:5432/mydb' }),
    environment: EnvironmentEnum.optional().openapi({ example: 'production' }),
    isSecret: z.boolean().optional().openapi({ example: true }),
  })
  .openapi('CreateEnvVar');

const BulkCreateSchema = z
  .object({
    variables: z
      .array(
        z.object({
          key: z.string().min(1).max(255),
          value: z.string().min(1),
          isSecret: z.boolean().optional(),
        })
      )
      .min(1)
      .max(100),
    environment: EnvironmentEnum.optional(),
  })
  .openapi('BulkCreateEnvVars');

const UpdateEnvVarSchema = z
  .object({
    value: z.string().min(1).optional(),
    isSecret: z.boolean().optional(),
  })
  .openapi('UpdateEnvVar');

// ============ Route Definitions ============

const listEnvVarsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Environment Variables'],
  summary: 'List environment variables',
  description: 'Get all environment variables for a project',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
    query: z.object({
      environment: EnvironmentEnum.optional(),
    }),
  },
  responses: {
    200: {
      description: 'List of environment variables',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(EnvVarSchema),
          }),
        },
      },
    },
  },
});

const createEnvVarRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Environment Variables'],
  summary: 'Create environment variable',
  description: 'Create a new environment variable for a project',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: CreateEnvVarSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Environment variable created',
      content: {
        'application/json': {
          schema: z.object({
            data: EnvVarSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const bulkCreateRoute = createRoute({
  method: 'post',
  path: '/bulk',
  tags: ['Environment Variables'],
  summary: 'Bulk create/update environment variables',
  description: 'Create or update multiple environment variables at once',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: BulkCreateSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Environment variables created/updated',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(BulkResultSchema),
            message: z.string(),
          }),
        },
      },
    },
  },
});

const getEnvVarRoute = createRoute({
  method: 'get',
  path: '/{envVarId}',
  tags: ['Environment Variables'],
  summary: 'Get environment variable',
  description: 'Get a specific environment variable',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      envVarId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Environment variable details',
      content: {
        'application/json': {
          schema: z.object({
            data: EnvVarSchema,
          }),
        },
      },
    },
  },
});

const updateEnvVarRoute = createRoute({
  method: 'patch',
  path: '/{envVarId}',
  tags: ['Environment Variables'],
  summary: 'Update environment variable',
  description: 'Update an existing environment variable',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      envVarId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: UpdateEnvVarSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Environment variable updated',
      content: {
        'application/json': {
          schema: z.object({
            data: EnvVarSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const deleteEnvVarRoute = createRoute({
  method: 'delete',
  path: '/{envVarId}',
  tags: ['Environment Variables'],
  summary: 'Delete environment variable',
  description: 'Delete an environment variable',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      envVarId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Environment variable deleted',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

// ============ Router ============

const envVarRouter = new OpenAPIHono<AppEnv>();

// JWT or API key (pk_live_...)
envVarRouter.use('*', combinedAuthMiddleware);

envVarRouter.get('/', requireScope('envvars:read'));
envVarRouter.post('/', requireScope('envvars:write'));
envVarRouter.post('/bulk', requireScope('envvars:write'));
envVarRouter.get('/:envVarId', requireScope('envvars:read'));
envVarRouter.patch('/:envVarId', requireScope('envvars:write'));
envVarRouter.delete('/:envVarId', requireScope('envvars:write'));
envVarRouter.post('/clone', requireScope('envvars:write'));

// List environment variables
envVarRouter.openapi(listEnvVarsRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const { environment } = c.req.valid('query');

  const envVars = await envVarService.getByProject(
    projectId,
    organizationId,
    userId,
    environment,
    locale
  );

  return c.json({ data: envVars });
});

// Create environment variable
envVarRouter.openapi(createEnvVarRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const input = c.req.valid('json');

  const envVar = await envVarService.create(projectId, organizationId, userId, input, locale);

  // Log activity
  await activityService.logEnvVarCreated(
    organizationId,
    userId,
    projectId,
    input.key,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent')
  );

  return c.json(
    {
      data: envVar,
      message: t(locale, 'envVars', 'created'),
    },
    201
  );
});

// Bulk create/update
envVarRouter.openapi(bulkCreateRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const input = c.req.valid('json');

  const results = await envVarService.bulkCreate(projectId, organizationId, userId, input, locale);

  return c.json({
    data: results,
    message: t(locale, 'envVars', 'bulkUpdated'),
  });
});

// Get environment variable
envVarRouter.openapi(getEnvVarRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, envVarId } = c.req.valid('param');

  const envVar = await envVarService.getById(envVarId, projectId, organizationId, userId, locale);

  return c.json({ data: envVar });
});

// Update environment variable
envVarRouter.openapi(updateEnvVarRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, envVarId } = c.req.valid('param');
  const input = c.req.valid('json');

  const envVar = await envVarService.update(
    envVarId,
    projectId,
    organizationId,
    userId,
    input,
    locale
  );

  return c.json({
    data: envVar,
    message: t(locale, 'envVars', 'updated'),
  });
});

// Delete environment variable
envVarRouter.openapi(deleteEnvVarRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, envVarId } = c.req.valid('param');

  // Get env var key before deleting
  const envVar = await envVarService.getById(envVarId, projectId, organizationId, userId, locale);

  await envVarService.delete(envVarId, projectId, organizationId, userId, locale);

  // Log activity
  await activityService.logEnvVarDeleted(
    organizationId,
    userId,
    projectId,
    envVar.key,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent')
  );

  return c.json({ message: t(locale, 'envVars', 'deleted') });
});

// Clone environment variables between environments
const cloneEnvVarsRoute = createRoute({
  method: 'post',
  path: '/clone',
  tags: ['Environment Variables'],
  summary: 'Clone environment variables',
  description: 'Copy all environment variables from one environment to another',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ projectId: z.string().uuid() }),
    body: {
      content: {
        'application/json': {
          schema: z.object({
            sourceEnvironment: EnvironmentEnum,
            targetEnvironment: EnvironmentEnum,
            overwrite: z.boolean().optional().default(false),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Environment variables cloned',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              copied: z.number(),
              skipped: z.number(),
              overwritten: z.number(),
            }),
            message: z.string(),
          }),
        },
      },
    },
    400: {
      description: 'Bad request',
      content: { 'application/json': { schema: z.object({ message: z.string() }) } },
    },
  },
});

envVarRouter.openapi(cloneEnvVarsRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const { sourceEnvironment, targetEnvironment, overwrite } = c.req.valid('json');

  if (sourceEnvironment === targetEnvironment) {
    return c.json({ message: t(locale, 'envVars', 'sameEnvironment') || 'Source and target environment cannot be the same' }, 400);
  }

  const result = await envVarService.cloneEnvironment(
    projectId, organizationId, userId, sourceEnvironment, targetEnvironment, overwrite, locale
  );

  return c.json({
    data: result,
    message: `Cloned ${result.copied} variables from ${sourceEnvironment} to ${targetEnvironment}`,
  });
});

export { envVarRouter as envVarRoutes };
