import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { randomBytes, createHash } from 'crypto';
import { authMiddleware } from '../middleware/auth';
import { authRateLimiter } from '../middleware/rate-limit';
import { apiKeyService } from '../services/apikey.service';
import type { AppEnv } from '../types';

// ─── In-memory store for CLI auth sessions ───
// In production, use Redis for multi-instance support
interface CliAuthSession {
  code: string;
  codeHash: string;
  status: 'pending' | 'approved' | 'expired';
  apiKey: string | null;
  createdAt: number;
  expiresAt: number;
}

const sessions = new Map<string, CliAuthSession>();

// Clean expired sessions every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(key);
    }
  }
}, 5 * 60 * 1000);

function generateCode(): string {
  return randomBytes(4).toString('hex').toUpperCase(); // 8-char hex code
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

// ─── Schemas ───

const CreateSessionResponseSchema = z
  .object({
    code: z.string(),
    expiresAt: z.number(),
  })
  .openapi('CliAuthCreateSession');

const PollResponseSchema = z
  .object({
    status: z.enum(['pending', 'approved', 'expired']),
    apiKey: z.string().nullable(),
  })
  .openapi('CliAuthPollResponse');

const ApproveRequestSchema = z
  .object({
    code: z.string().min(1),
  })
  .openapi('CliAuthApproveRequest');

// ─── Routes ───

const createSessionRoute = createRoute({
  method: 'post',
  path: '/create-session',
  tags: ['CLI Authentication'],
  summary: 'Create a CLI auth session',
  description: 'Generates a temporary code for browser-based CLI authentication',
  responses: {
    200: {
      description: 'Session created',
      content: { 'application/json': { schema: CreateSessionResponseSchema } },
    },
  },
});

const pollRoute = createRoute({
  method: 'get',
  path: '/poll/{code}',
  tags: ['CLI Authentication'],
  summary: 'Poll CLI auth session status',
  description: 'CLI polls this endpoint to check if the user approved the login',
  request: {
    params: z.object({ code: z.string() }),
  },
  responses: {
    200: {
      description: 'Session status',
      content: { 'application/json': { schema: PollResponseSchema } },
    },
  },
});

const approveRoute = createRoute({
  method: 'post',
  path: '/approve',
  tags: ['CLI Authentication'],
  summary: 'Approve CLI login from browser',
  description: 'Authenticated user approves a CLI auth session, generating an API key',
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      content: { 'application/json': { schema: ApproveRequestSchema } },
    },
  },
  responses: {
    200: {
      description: 'Approved',
      content: { 'application/json': { schema: z.object({ message: z.string() }) } },
    },
  },
});

// ─── Router ───

const cliAuthRouter = new OpenAPIHono<AppEnv>();

cliAuthRouter.use('/create-session', authRateLimiter);
cliAuthRouter.use('/poll/*', authRateLimiter);

// POST /create-session — CLI calls this to get a code
cliAuthRouter.openapi(createSessionRoute, async (c) => {
  const code = generateCode();
  const codeHash = hashCode(code);
  const now = Date.now();
  const expiresAt = now + 10 * 60 * 1000; // 10 minutes

  sessions.set(codeHash, {
    code,
    codeHash,
    status: 'pending',
    apiKey: null,
    createdAt: now,
    expiresAt,
  });

  return c.json({ code, expiresAt });
});

// GET /poll/:code — CLI polls this
cliAuthRouter.openapi(pollRoute, async (c) => {
  const { code } = c.req.valid('param');
  const codeHash = hashCode(code);
  const session = sessions.get(codeHash);

  if (!session) {
    return c.json({ status: 'expired' as const, apiKey: null });
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(codeHash);
    return c.json({ status: 'expired' as const, apiKey: null });
  }

  if (session.status === 'approved') {
    const apiKey = session.apiKey;
    sessions.delete(codeHash); // One-time read
    return c.json({ status: 'approved' as const, apiKey });
  }

  return c.json({ status: 'pending' as const, apiKey: null });
});

// POST /approve — Browser calls this (authenticated)
cliAuthRouter.use('/approve', authMiddleware);
cliAuthRouter.openapi(approveRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const { code } = c.req.valid('json');
  const codeHash = hashCode(code.toUpperCase());
  const session = sessions.get(codeHash);

  if (!session) {
    return c.json({ message: 'Invalid or expired code' }, 400);
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(codeHash);
    return c.json({ message: 'Code expired' }, 400);
  }

  if (session.status === 'approved') {
    return c.json({ message: 'Already approved' }, 400);
  }

  // Create an API key for CLI usage
  const result = await apiKeyService.create(userId, organizationId, {
    name: `CLI Login (${new Date().toLocaleDateString()})`,
    scopes: ['*'],
  });

  session.status = 'approved';
  session.apiKey = result.secretKey;

  return c.json({ message: 'CLI login approved' });
});

export { cliAuthRouter as cliAuthRoutes };
