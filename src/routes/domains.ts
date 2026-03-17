import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { domainService } from '../services/domain.service';
import { activityService } from '../services/activity.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

// ============ Schemas ============

const DomainSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    domain: z.string(),
    isPrimary: z.boolean(),
    sslStatus: z.string().nullable(),
    verifiedAt: z.coerce.date().nullable(),
    createdAt: z.coerce.date(),
  })
  .openapi('Domain');

const MessageSchema = z
  .object({
    message: z.string(),
  })
  .openapi('DomainMessage');

// ============ Request Schemas ============

const CreateDomainSchema = z
  .object({
    domain: z.string().min(1).max(255).openapi({ example: 'app.example.com' }),
    isPrimary: z.boolean().optional().openapi({ example: false }),
  })
  .openapi('CreateDomain');

const NginxSettingsSchema = z
  .object({
    proxyPort: z.number().min(1).max(65535).optional().openapi({ example: 3000, description: 'Override the container port for this domain' }),
    proxyTimeout: z.number().min(1).max(86400).optional().openapi({ example: 86400 }),
    clientMaxBodySize: z.string().regex(/^\d+[kmg]?$/i).optional().openapi({ example: '100m' }),
    enableWebsocket: z.boolean().optional().openapi({ example: true }),
    enableGzip: z.boolean().optional().openapi({ example: true }),
    forceHttps: z.boolean().optional().openapi({ example: true }),
    customHeaders: z.record(z.string(), z.string()).optional().openapi({ example: { 'X-Custom-Header': 'value' } }),
    rateLimit: z.object({
      enabled: z.boolean(),
      requestsPerSecond: z.number().min(1).max(1000),
      burst: z.number().min(1).max(100),
    }).optional(),
    caching: z.object({
      enabled: z.boolean(),
      maxAge: z.number().min(1).max(31536000),
      staleWhileRevalidate: z.number().optional(),
    }).optional(),
    customLocationBlocks: z.string().max(10000).optional(),
  })
  .openapi('NginxSettings');

// ============ Route Definitions ============

const listDomainsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Domains'],
  summary: 'List domains',
  description: 'Get all domains for a project',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'List of domains',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(DomainSchema),
          }),
        },
      },
    },
  },
});

const createDomainRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Domains'],
  summary: 'Add domain',
  description: 'Add a new domain to a project',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: CreateDomainSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Domain added',
      content: {
        'application/json': {
          schema: z.object({
            data: DomainSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const getDomainRoute = createRoute({
  method: 'get',
  path: '/{domainId}',
  tags: ['Domains'],
  summary: 'Get domain',
  description: 'Get a specific domain',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      domainId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Domain details',
      content: {
        'application/json': {
          schema: z.object({
            data: DomainSchema,
          }),
        },
      },
    },
  },
});

const setPrimaryRoute = createRoute({
  method: 'post',
  path: '/{domainId}/primary',
  tags: ['Domains'],
  summary: 'Set primary domain',
  description: 'Set a domain as the primary domain for the project',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      domainId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Primary domain updated',
      content: {
        'application/json': {
          schema: z.object({
            data: DomainSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const verifyDomainRoute = createRoute({
  method: 'post',
  path: '/{domainId}/verify',
  tags: ['Domains'],
  summary: 'Verify domain',
  description: 'Verify domain DNS configuration and SSL certificate',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      domainId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Domain verified',
      content: {
        'application/json': {
          schema: z.object({
            data: DomainSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const getDnsSetupRoute = createRoute({
  method: 'get',
  path: '/{domainId}/dns-setup',
  tags: ['Domains'],
  summary: 'Get DNS setup instructions',
  description: 'Get DNS configuration instructions for a domain (A record setup)',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      domainId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'DNS setup information',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              domain: z.string(),
              serverIp: z.string().nullable(),
              recordType: z.literal('A'),
              currentIp: z.string().nullable(),
              isConfigured: z.boolean(),
              message: z.string(),
            }),
          }),
        },
      },
    },
  },
});

const getNginxSettingsRoute = createRoute({
  method: 'get',
  path: '/{domainId}/nginx-settings',
  tags: ['Domains'],
  summary: 'Get Nginx settings',
  description: 'Get custom Nginx settings for a domain',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      domainId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Nginx settings',
      content: {
        'application/json': {
          schema: z.object({
            data: NginxSettingsSchema,
          }),
        },
      },
    },
  },
});

const updateNginxSettingsRoute = createRoute({
  method: 'patch',
  path: '/{domainId}/nginx-settings',
  tags: ['Domains'],
  summary: 'Update Nginx settings',
  description: 'Update custom Nginx settings for a domain and apply to server',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      domainId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: NginxSettingsSchema,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Nginx settings updated',
      content: {
        'application/json': {
          schema: z.object({
            data: NginxSettingsSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const deleteDomainRoute = createRoute({
  method: 'delete',
  path: '/{domainId}',
  tags: ['Domains'],
  summary: 'Remove domain',
  description: 'Remove a domain from a project',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      domainId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Domain removed',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

// ============ Router ============

const domainRouter = new OpenAPIHono<AppEnv>();

// All routes require authentication
domainRouter.use('*', authMiddleware);

// List domains
domainRouter.openapi(listDomainsRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');

  const domains = await domainService.getByProject(projectId, organizationId, userId, locale);

  return c.json({ data: domains });
});

// Create domain
domainRouter.openapi(createDomainRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const input = c.req.valid('json');

  const domain = await domainService.create(projectId, organizationId, userId, input, locale);

  // Log activity
  await activityService.logDomainAdded(
    organizationId,
    userId,
    projectId,
    input.domain,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent')
  );

  return c.json(
    {
      data: domain,
      message: t(locale, 'domains', 'created'),
    },
    201
  );
});

// Get domain
domainRouter.openapi(getDomainRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, domainId } = c.req.valid('param');

  const domain = await domainService.getById(domainId, projectId, organizationId, userId, locale);

  return c.json({ data: domain });
});

// Set primary
domainRouter.openapi(setPrimaryRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, domainId } = c.req.valid('param');

  const domain = await domainService.setPrimary(
    domainId,
    projectId,
    organizationId,
    userId,
    locale
  );

  // Log activity
  await activityService.log({
    organizationId,
    userId,
    projectId,
    action: 'domain.set_primary',
    description: `Set "${domain.domain}" as primary domain`,
    metadata: { domain: domain.domain },
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({
    data: domain,
    message: t(locale, 'domains', 'setPrimary'),
  });
});

// Verify domain
domainRouter.openapi(verifyDomainRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, domainId } = c.req.valid('param');

  const domain = await domainService.verify(domainId, projectId, organizationId, userId, locale);

  // Log activity
  await activityService.log({
    organizationId,
    userId,
    projectId,
    action: 'domain.verified',
    description: `Verified domain "${domain.domain}"`,
    metadata: { domain: domain.domain },
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({
    data: domain,
    message: t(locale, 'domains', 'verified'),
  });
});

// Get DNS setup instructions
domainRouter.openapi(getDnsSetupRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, domainId } = c.req.valid('param');

  const dnsSetup = await domainService.getDnsSetup(domainId, projectId, organizationId, userId, locale);

  return c.json({ data: dnsSetup });
});

// Get Nginx settings
domainRouter.openapi(getNginxSettingsRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, domainId } = c.req.valid('param');

  const settings = await domainService.getNginxSettings(domainId, projectId, organizationId, userId, locale);

  return c.json({ data: settings });
});

// Update Nginx settings
domainRouter.openapi(updateNginxSettingsRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, domainId } = c.req.valid('param');
  const settings = c.req.valid('json');

  const updatedSettings = await domainService.updateNginxSettings(
    domainId,
    projectId,
    organizationId,
    userId,
    settings,
    locale
  );

  // Log activity
  await activityService.log({
    organizationId,
    userId,
    projectId,
    action: 'domain.nginx_updated',
    description: 'Updated Nginx settings for domain',
    metadata: { domainId, settings },
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({
    data: updatedSettings,
    message: t(locale, 'domains', 'nginxUpdated'),
  });
});

// Delete domain
domainRouter.openapi(deleteDomainRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, domainId } = c.req.valid('param');

  // Get domain before deleting
  const domain = await domainService.getById(domainId, projectId, organizationId, userId, locale);

  await domainService.delete(domainId, projectId, organizationId, userId, locale);

  // Log activity
  await activityService.logDomainRemoved(
    organizationId,
    userId,
    projectId,
    domain.domain,
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent')
  );

  return c.json({ message: t(locale, 'domains', 'deleted') });
});

export { domainRouter as domainRoutes };
