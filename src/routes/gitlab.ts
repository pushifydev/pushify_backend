import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { gitlabService } from '../services/gitlab.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';
import { HTTPException } from 'hono/http-exception';
import {
  createOAuthState,
  consumeOAuthState,
  validateOAuthStateRecord,
} from '../lib/oauth-state-store';

const GitLabStatusSchema = z
  .object({
    connected: z.boolean(),
    username: z.string().nullable(),
  })
  .openapi('GitLabStatus');

const GitLabRepoSchema = z
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
  .openapi('GitLabRepo');

const GitLabBranchSchema = z
  .object({
    name: z.string(),
    commit: z.object({
      sha: z.string(),
      url: z.string(),
    }),
    protected: z.boolean(),
  })
  .openapi('GitLabBranch');

const FrameworkDetectionSchema = z
  .object({
    framework: z.string().nullable(),
    buildCommand: z.string().nullable(),
    installCommand: z.string().nullable(),
    outputDirectory: z.string().nullable(),
    startCommand: z.string().nullable(),
  })
  .openapi('GitLabFrameworkDetection');

const gitlabRouter = new OpenAPIHono<AppEnv>();
gitlabRouter.use('*', authMiddleware);

const statusRoute = createRoute({
  method: 'get',
  path: '/status',
  tags: ['GitLab'],
  summary: 'Get GitLab connection status',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ data: GitLabStatusSchema }) } },
      description: 'Status',
    },
  },
});

const authUrlRoute = createRoute({
  method: 'get',
  path: '/auth-url',
  tags: ['GitLab'],
  summary: 'Get GitLab OAuth URL',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ data: z.object({ url: z.string(), state: z.string() }) }),
        },
      },
      description: 'Auth URL',
    },
  },
});

const callbackRoute = createRoute({
  method: 'post',
  path: '/callback',
  tags: ['GitLab'],
  summary: 'GitLab OAuth callback',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ code: z.string(), state: z.string() }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ data: GitLabStatusSchema, message: z.string() }),
        },
      },
      description: 'Connected',
    },
  },
});

const disconnectRoute = createRoute({
  method: 'delete',
  path: '/disconnect',
  tags: ['GitLab'],
  summary: 'Disconnect GitLab',
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: z.object({ message: z.string() }) } },
      description: 'Disconnected',
    },
  },
});

const reposRoute = createRoute({
  method: 'get',
  path: '/repos',
  tags: ['GitLab'],
  summary: 'List GitLab projects',
  security: [{ bearerAuth: [] }],
  request: {
    query: z.object({
      page: z.coerce.number().optional().default(1),
      per_page: z.coerce.number().optional().default(30),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: z.object({ data: z.array(GitLabRepoSchema) }) },
      },
      description: 'Projects',
    },
  },
});

const branchesRoute = createRoute({
  method: 'get',
  path: '/projects/{projectId}/branches',
  tags: ['GitLab'],
  summary: 'List branches',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ projectId: z.coerce.number() }),
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: z.object({ data: z.array(GitLabBranchSchema) }) },
      },
      description: 'Branches',
    },
  },
});

const detectRoute = createRoute({
  method: 'get',
  path: '/projects/{projectId}/detect',
  tags: ['GitLab'],
  summary: 'Detect framework',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ projectId: z.coerce.number() }),
    query: z.object({ branch: z.string().optional() }),
  },
  responses: {
    200: {
      content: {
        'application/json': { schema: z.object({ data: FrameworkDetectionSchema }) },
      },
      description: 'Detection',
    },
  },
});

gitlabRouter.openapi(statusRoute, async (c) => {
  const userId = c.get('userId')!;
  const integration = await gitlabService.getIntegration(userId);
  return c.json({
    data: {
      connected: !!integration,
      username: integration?.providerUsername || null,
    },
  });
});

gitlabRouter.openapi(authUrlRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const state = await createOAuthState({ kind: 'gitlab_integration', userId });
  try {
    const url = gitlabService.getAuthorizationUrl(state);
    return c.json({ data: { url, state } });
  } catch {
    throw new HTTPException(500, { message: t(locale, 'integrations', 'notConfigured') });
  }
});

gitlabRouter.openapi(callbackRoute, async (c) => {
  const { code, state } = c.req.valid('json');
  const userId = c.get('userId')!;
  const locale = c.get('locale');

  const stored = await consumeOAuthState(state);
  if (!validateOAuthStateRecord(stored, { kind: 'gitlab_integration', userId })) {
    throw new HTTPException(400, { message: t(locale, 'integrations', 'invalidState') });
  }

  try {
    const tokenData = await gitlabService.exchangeCodeForToken(code);
    const gitlabUser = await gitlabService.getUser(tokenData.access_token);
    await gitlabService.saveIntegration(userId, tokenData, gitlabUser);

    return c.json({
      data: { connected: true, username: gitlabUser.username },
      message: t(locale, 'integrations', 'connected'),
    });
  } catch (error) {
    if (error instanceof HTTPException) throw error;
    throw new HTTPException(400, { message: t(locale, 'integrations', 'oauthFailed') });
  }
});

gitlabRouter.openapi(disconnectRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  await gitlabService.disconnectIntegration(userId);
  return c.json({ message: t(locale, 'integrations', 'disconnected') });
});

gitlabRouter.openapi(reposRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { page, per_page } = c.req.valid('query');
  const accessToken = await gitlabService.getAccessToken(userId, locale);
  const repos = await gitlabService.getRepositories(accessToken, { page, perPage: per_page });
  return c.json({ data: repos });
});

gitlabRouter.openapi(branchesRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const accessToken = await gitlabService.getAccessToken(userId, locale);
  const branches = await gitlabService.getBranches(accessToken, projectId);
  return c.json({ data: branches });
});

gitlabRouter.openapi(detectRoute, async (c) => {
  const userId = c.get('userId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const { branch } = c.req.valid('query');
  const accessToken = await gitlabService.getAccessToken(userId, locale);
  const detection = await gitlabService.detectFramework(accessToken, projectId, branch);
  return c.json({ data: detection });
});

export { gitlabRouter as gitlabRoutes };
