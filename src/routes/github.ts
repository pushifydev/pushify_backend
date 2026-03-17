import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { githubService } from '../services/github.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';
import { HTTPException } from 'hono/http-exception';
import crypto from 'crypto';

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

// In-memory state store (in production, use Redis or database)
const oauthStates = new Map<string, { userId: string; expiresAt: number }>();

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

  // Generate random state
  const state = crypto.randomBytes(32).toString('hex');

  // Store state with expiration (10 minutes)
  oauthStates.set(state, {
    userId,
    expiresAt: Date.now() + 10 * 60 * 1000,
  });

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

  // Verify state
  const storedState = oauthStates.get(state);
  if (!storedState || storedState.userId !== userId || storedState.expiresAt < Date.now()) {
    oauthStates.delete(state);
    throw new HTTPException(400, { message: t(locale, 'integrations', 'invalidState') });
  }
  oauthStates.delete(state);

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

export { githubRouter as githubRoutes };
