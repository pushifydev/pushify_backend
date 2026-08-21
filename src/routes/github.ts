import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { githubService } from '../services/github.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';
import { HTTPException } from 'hono/http-exception';
import { githubAppService } from '../services/github-app.service';
import {
  createOAuthState,
  consumeOAuthState,
  validateOAuthStateRecord,
} from '../lib/oauth-state-store';

// ============ Schemas ============

const GitHubStatusSchema = z
  .object({
    connected: z.boolean(),
    username: z.string().nullable(),
  })
  .openapi('GitHubStatus');

const GitHubRepoSchema = z
  .object({
    id: z.number(),
    name: z.string(),
    full_name: z.string(),
    private: z.boolean(),
    html_url: z.string(),
    clone_url: z.string(),
    ssh_url: z.string(),
    default_branch: z.string(),
    description: z.string().nullable(),
    language: z.string().nullable(),
    updated_at: z.string(),
    pushed_at: z.string(),
  })
  .openapi('GitHubRepo');

const GitHubBranchSchema = z
  .object({
    name: z.string(),
    commit: z.object({
      sha: z.string(),
      url: z.string(),
    }),
    protected: z.boolean(),
  })
  .openapi('GitHubBranch');

const FrameworkDetectionSchema = z
  .object({
    framework: z.string().nullable(),
    buildCommand: z.string().nullable(),
    installCommand: z.string().nullable(),
    outputDirectory: z.string().nullable(),
    startCommand: z.string().nullable(),
  })
  .openapi('FrameworkDetection');

const MessageSchema = z
  .object({
    message: z.string(),
  })
  .openapi('Message');

const AuthUrlSchema = z
  .object({
    url: z.string(),
    state: z.string(),
  })
  .openapi('AuthUrl');

// ============ Route Definitions ============

// Get GitHub connection status
const statusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: ['GitHub'],
  summary: 'Get GitHub connection status',
  description: 'Check if the user has connected their GitHub account',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'GitHub connection status',
      content: {
        'application/json': {
          schema: z.object({ data: GitHubStatusSchema }),
        },
      },
    },
  },
});

// Get OAuth URL
const authUrlRoute = createRoute({
  method: 'get',
  path: '/auth-url',
  tags: ['GitHub'],
  summary: 'Get GitHub OAuth URL',
  description: 'Generate GitHub OAuth authorization URL',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'OAuth authorization URL',
      content: {
        'application/json': {
          schema: z.object({ data: AuthUrlSchema }),
        },
      },
    },
  },
});

// OAuth callback
const callbackRoute = createRoute({
  method: 'post',
  path: '/callback',
  tags: ['GitHub'],
  summary: 'Handle GitHub OAuth callback',
  description: 'Exchange authorization code for access token and save integration',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            code: z.string(),
            state: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'GitHub connected successfully',
      content: {
        'application/json': {
          schema: z.object({ data: GitHubStatusSchema, message: z.string() }),
        },
      },
    },
  },
});

// Disconnect GitHub
const disconnectRoute = createRoute({
  method: 'delete',
  path: '/disconnect',
  tags: ['GitHub'],
  summary: 'Disconnect GitHub',
  description: 'Remove GitHub integration from user account',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'GitHub disconnected',
      content: {
        'application/json': {
          schema: MessageSchema,
        },
      },
    },
  },
});

// List repositories
const reposRoute = createRoute({
  method: 'get',
  path: '/repos',
  tags: ['GitHub'],
  summary: 'List repositories',
  description: 'Get user repositories from GitHub',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.coerce.number().optional().default(1),
      per_page: z.coerce.number().optional().default(30),
      sort: z.enum(['created', 'updated', 'pushed', 'full_name']).optional().default('updated'),
    }),
  },
  responses: {
    200: {
      description: 'List of repositories',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(GitHubRepoSchema) }),
        },
      },
    },
  },
});

// Get repository branches
const branchesRoute = createRoute({
  method: 'get',
  path: '/repos/{owner}/{repo}/branches',
  tags: ['GitHub'],
  summary: 'List repository branches',
  description: 'Get branches for a specific repository',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      owner: z.string(),
      repo: z.string(),
    }),
  },
  responses: {
    200: {
      description: 'List of branches',
      content: {
        'application/json': {
          schema: z.object({ data: z.array(GitHubBranchSchema) }),
        },
      },
    },
  },
});

// Detect framework
const detectRoute = createRoute({
  method: 'get',
  path: '/repos/{owner}/{repo}/detect',
  tags: ['GitHub'],
  summary: 'Detect framework',
  description: 'Detect project framework and build settings from repository',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      owner: z.string(),
      repo: z.string(),
    }),
    query: z.object({
      branch: z.string().optional(),
    }),
  },
  responses: {
    200: {
      description: 'Framework detection result',
      content: {
        'application/json': {
          schema: z.object({ data: FrameworkDetectionSchema }),
        },
      },
    },
  },
});

// ============ Router ============

const githubRouter = new OpenAPIHono<AppEnv>();

// All routes require authentication
githubRouter.use('*', authMiddleware);

// Get status
githubRouter.openapi(statusRoute, async (c) => {
  const userId = c.get('userId')!;
  const integration = await githubService.getIntegration(userId);

  return c.json({
    data: {
      connected: !!integration,
      username: integration?.providerUsername || null,
    },
  });
});

// Get auth URL
githubRouter.openapi(authUrlRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  const state = await createOAuthState({ kind: 'github_integration', userId });

  try {
    const url = githubService.getAuthorizationUrl(state);
    return c.json({ data: { url, state } });
  } catch {
    throw new HTTPException(500, { message: t(locale, 'integrations', 'notConfigured') });
  }
});

// Handle callback
githubRouter.openapi(callbackRoute, async (c) => {
  const { code, state } = c.req.valid('json');
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  const stored = await consumeOAuthState(state);
  if (!validateOAuthStateRecord(stored, { kind: 'github_integration', userId })) {
    throw new HTTPException(400, { message: t(locale, 'integrations', 'invalidState') });
  }

  try {
    // Exchange code for token
    const tokenData = await githubService.exchangeCodeForToken(code);

    // Get GitHub user info
    const githubUser = await githubService.getUser(tokenData.access_token);

    // Save integration
    await githubService.saveIntegration(userId, tokenData, githubUser);

    return c.json({
      data: {
        connected: true,
        username: githubUser.login,
      },
      message: t(locale, 'integrations', 'connected'),
    });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: t(locale, 'integrations', 'oauthFailed') });
  }
});

// Disconnect
githubRouter.openapi(disconnectRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  await githubService.disconnectIntegration(userId);

  return c.json({ message: t(locale, 'integrations', 'disconnected') });
});

// List repos
githubRouter.openapi(reposRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { page, per_page, sort } = c.req.valid('query');

  const accessToken = await githubService.getAccessToken(userId, locale);
  const repos = await githubService.getRepositories(accessToken, {
    page,
    perPage: per_page,
    sort,
  });

  return c.json({ data: repos });
});

// List branches
githubRouter.openapi(branchesRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { owner, repo } = c.req.valid('param');

  const accessToken = await githubService.getAccessToken(userId, locale);
  const branches = await githubService.getBranches(accessToken, owner, repo);

  return c.json({ data: branches });
});

// Detect framework
githubRouter.openapi(detectRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { owner, repo } = c.req.valid('param');
  const { branch } = c.req.valid('query');

  const accessToken = await githubService.getAccessToken(userId, locale);
  const detection = await githubService.detectFramework(accessToken, owner, repo, branch);

  return c.json({ data: detection });
});


// ============ GitHub App ============

/**
 * Where the browser goes to install the App. The state carries the organisation, because after
 * GitHub redirects back that is the only way to know which one the person was acting for.
 */
const appInstallRoute = createRoute({
  method: 'get',
  path: '/app/install-url',
  tags: ['GitHub'],
  summary: 'Get the GitHub App installation URL',
  responses: {
    200: {
      description: 'Installation URL',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({ url: z.string().nullable(), configured: z.boolean() }),
          }),
        },
      },
    },
  },
});

/** Called by our own frontend after GitHub redirects back from the installation screen. */
const appSetupRoute = createRoute({
  method: 'post',
  path: '/app/setup',
  tags: ['GitHub'],
  summary: 'Link a finished GitHub App installation to the organization',
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ installationId: z.number().int().positive(), state: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Installation linked',
      content: {
        'application/json': {
          schema: z.object({ data: z.object({ installationId: z.number(), accountLogin: z.string() }) }),
        },
      },
    },
  },
});

const appInstallationsRoute = createRoute({
  method: 'get',
  path: '/app/installations',
  tags: ['GitHub'],
  summary: 'List the organization\'s GitHub App installations',
  responses: {
    200: {
      description: 'Installations',
      content: {
        'application/json': {
          schema: z.object({
            data: z.object({
              configured: z.boolean(),
              installations: z.array(
                z.object({
                  installationId: z.number(),
                  accountLogin: z.string(),
                  accountType: z.string().nullable(),
                  repositorySelection: z.string().nullable(),
                  suspended: z.boolean(),
                })
              ),
            }),
          }),
        },
      },
    },
  },
});

const appRepositoriesRoute = createRoute({
  method: 'get',
  path: '/app/installations/{installationId}/repositories',
  tags: ['GitHub'],
  summary: 'List repositories an installation can reach',
  request: { params: z.object({ installationId: z.string() }) },
  responses: {
    200: {
      description: 'Repositories',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(
              z.object({
                id: z.number(),
                fullName: z.string(),
                private: z.boolean(),
                defaultBranch: z.string(),
                htmlUrl: z.string(),
              })
            ),
          }),
        },
      },
    },
  },
});

githubRouter.openapi(appInstallRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;

  if (!githubAppService.isConfigured()) {
    return c.json({ data: { url: null, configured: false } });
  }

  const state = await createOAuthState({ kind: 'github_app_install', userId, organizationId });
  return c.json({ data: { url: githubAppService.installUrl(state), configured: true } });
});

githubRouter.openapi(appSetupRoute, async (c) => {
  const { installationId, state } = c.req.valid('json');
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const stored = await consumeOAuthState(state);
  if (
    !stored ||
    stored.kind !== 'github_app_install' ||
    stored.userId !== userId ||
    stored.organizationId !== organizationId
  ) {
    throw new HTTPException(400, { message: t(locale, 'integrations', 'invalidState') });
  }

  // The webhook usually arrives first; fetching here would need an extra API call, so an
  // installation we have not seen yet is recorded with what we know and filled in on sync.
  const existing = await githubAppService.findByInstallationId(installationId);
  if (!existing) {
    await githubAppService.syncInstallation({
      installationId,
      accountLogin: 'pending',
    });
  }

  const claimed = await githubAppService.claimInstallation(installationId, organizationId, userId);
  const installation = claimed ?? (await githubAppService.findByInstallationId(installationId));

  if (!installation) {
    throw new HTTPException(404, { message: 'Installation not found' });
  }

  // Already claimed by another organisation: refuse rather than silently move it.
  if (installation.organizationId !== organizationId) {
    throw new HTTPException(409, {
      message: 'This GitHub App installation is already linked to another organization',
    });
  }

  return c.json({
    data: { installationId, accountLogin: installation.accountLogin },
  });
});

githubRouter.openapi(appInstallationsRoute, async (c) => {
  const organizationId = c.get('organizationId')!;

  if (!githubAppService.isConfigured()) {
    return c.json({ data: { configured: false, installations: [] } });
  }

  const installations = await githubAppService.listForOrganization(organizationId);

  return c.json({
    data: {
      configured: true,
      installations: installations.map((installation) => ({
        installationId: installation.installationId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        suspended: Boolean(installation.suspendedAt),
      })),
    },
  });
});

githubRouter.openapi(appRepositoriesRoute, async (c) => {
  const organizationId = c.get('organizationId')!;
  const installationId = Number(c.req.valid('param').installationId);

  const installation = await githubAppService.findByInstallationId(installationId);
  // Scoped to the caller's organisation: an installation id is guessable, its contents are not.
  if (!installation || installation.organizationId !== organizationId) {
    throw new HTTPException(404, { message: 'Installation not found' });
  }

  const repositories = await githubAppService.listRepositories(installationId);
  return c.json({ data: repositories });
});

export { githubRouter as githubRoutes };
