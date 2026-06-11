import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getConnInfo } from '@hono/node-server/conninfo';
import { getOptionalRedis } from '../lib/redis-client';
import { redisFixedWindowHit } from '../lib/rate-limit-redis';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { getApiRequestsPerMinute, type PlanType } from '../lib/plans';
import { organizationRepository } from '../repositories/organization.repository';

export interface RateLimitConfig {
  /** Isolates counters between limiters (auth vs general, etc.) */
  namespace: string;
  windowMs: number;
  maxRequests: number;
  /** When set, overrides maxRequests per request (e.g. plan-based API limits) */
  resolveMaxRequests?: (c: Context) => number | Promise<number>;
  keyGenerator?: (c: Context) => string;
  skip?: (c: Context) => boolean;
  message?: string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

function getSocketIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Derive the client IP for rate limiting.
 *
 * X-Forwarded-For is client-controllable, so it is ONLY trusted when TRUSTED_PROXY_HOPS
 * is configured (the number of reverse proxies in front of the app). With the default of
 * 0 we use the real socket address and ignore the header entirely — otherwise an attacker
 * could rotate X-Forwarded-For to get a fresh counter per request and bypass the limit (H-3).
 */
function getClientIp(c: Context): string {
  const hops = env.TRUSTED_PROXY_HOPS;
  if (hops > 0) {
    const xff = c.req.header('x-forwarded-for');
    if (xff) {
      const ips = xff.split(',').map((s) => s.trim()).filter(Boolean);
      // Each trusted proxy appends the peer it saw, so the real client is `hops` from the
      // right. Anything further left is attacker-supplied and must not be trusted.
      const idx = ips.length - hops;
      if (idx >= 0 && idx < ips.length) return ips[idx];
      if (ips.length > 0) return ips[0];
    }
  }
  return getSocketIp(c);
}

function defaultKeyGenerator(c: Context): string {
  return getClientIp(c);
}

export function createRateLimiter(config: RateLimitConfig) {
  const {
    namespace,
    windowMs,
    maxRequests,
    resolveMaxRequests,
    keyGenerator = defaultKeyGenerator,
    skip,
    message = 'Too many requests, please try again later',
  } = config;

  return async function rateLimitMiddleware(c: Context, next: Next) {
    if (skip?.(c)) {
      return next();
    }

    const limit =
      resolveMaxRequests !== undefined ? await resolveMaxRequests(c) : maxRequests;

    if (limit === -1) {
      return next();
    }

    const clientKey = keyGenerator(c);
    const storeKey = `${namespace}:${clientKey}`;
    const redis = getOptionalRedis();

    if (redis) {
      try {
        const rlKey = `pushify:rl:${namespace}:${clientKey}`;
        const r = await redisFixedWindowHit(redis, rlKey, windowMs, limit);
        const remaining = Math.max(0, limit - r.count);
        const resetInSeconds = Math.max(0, Math.ceil((r.resetAtMs - Date.now()) / 1000));

        c.header('X-RateLimit-Limit', limit.toString());
        c.header('X-RateLimit-Remaining', remaining.toString());
        c.header('X-RateLimit-Reset', Math.ceil(r.resetAtMs / 1000).toString());
        c.header('Retry-After', resetInSeconds.toString());

        if (!r.allowed) {
          throw new HTTPException(429, { message });
        }

        await next();
        return;
      } catch (e) {
        if (e instanceof HTTPException) {
          throw e;
        }
        logger.warn({ err: e, namespace }, 'Redis rate limit failed; using in-memory fallback');
      }
    }

    const now = Date.now();
    let entry = rateLimitStore.get(storeKey);

    if (!entry || entry.resetAt < now) {
      entry = {
        count: 0,
        resetAt: now + windowMs,
      };
    }

    entry.count++;
    rateLimitStore.set(storeKey, entry);

    const remaining = Math.max(0, limit - entry.count);
    const resetInSeconds = Math.ceil((entry.resetAt - now) / 1000);

    c.header('X-RateLimit-Limit', limit.toString());
    c.header('X-RateLimit-Remaining', remaining.toString());
    c.header('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000).toString());
    c.header('Retry-After', resetInSeconds.toString());

    if (entry.count > limit) {
      throw new HTTPException(429, {
        message,
      });
    }

    await next();
  };
}

export const authRateLimiter = createRateLimiter({
  namespace: 'auth',
  windowMs: 60 * 1000,
  maxRequests: env.RATE_LIMIT_AUTH_MAX,
  message: 'Too many authentication attempts, please try again in a minute',
});

export const passwordResetRateLimiter = createRateLimiter({
  namespace: 'password-reset',
  windowMs: 15 * 60 * 1000,
  maxRequests: env.RATE_LIMIT_PASSWORD_RESET_MAX,
  message: 'Too many password reset requests, please try again later',
});

export const apiRateLimiter = createRateLimiter({
  namespace: 'api',
  windowMs: 60 * 1000,
  maxRequests: env.RATE_LIMIT_API_MAX,
  message: 'API rate limit exceeded, please slow down your requests',
});

/** IP-based limit for unauthenticated /api routes (auth, health, webhooks, etc.) */
export const generalRateLimiter = createRateLimiter({
  namespace: 'general',
  windowMs: 60 * 1000,
  maxRequests: env.RATE_LIMIT_API_MAX,
  skip: (c) => {
    const auth = c.req.header('Authorization');
    if (auth?.startsWith('Bearer ')) return true;
    if (c.req.query('token')) return true;
    return false;
  },
});

const ORG_PLAN_CACHE_TTL_MS = 60_000;
const orgPlanCache = new Map<string, { plan: PlanType; expiresAt: number }>();

async function getOrganizationPlan(organizationId: string): Promise<PlanType> {
  const cached = orgPlanCache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.plan;
  }

  const org = await organizationRepository.findById(organizationId);
  const plan = (org?.plan ?? 'free') as PlanType;
  orgPlanCache.set(organizationId, { plan, expiresAt: Date.now() + ORG_PLAN_CACHE_TTL_MS });
  return plan;
}

async function resolvePlanApiMaxRequests(c: Context): Promise<number> {
  const organizationId = c.get('organizationId') as string | undefined;
  if (organizationId) {
    const plan = await getOrganizationPlan(organizationId);
    return getApiRequestsPerMinute(plan);
  }
  return getApiRequestsPerMinute('free');
}

function planApiRateLimitKey(c: Context): string {
  const apiKey = c.get('apiKey') as { id: string } | undefined;
  if (apiKey?.id) {
    return `apikey:${apiKey.id}`;
  }

  const organizationId = c.get('organizationId') as string | undefined;
  if (organizationId) {
    return `org:${organizationId}`;
  }

  const userId = c.get('userId') as string | undefined;
  if (userId) {
    return `user:${userId}`;
  }

  return getClientIp(c);
}

/** Per API key / org, per plan — runs after JWT or API key auth */
export const planApiRateLimiter = createRateLimiter({
  namespace: 'api-plan',
  windowMs: 60 * 1000,
  maxRequests: 60,
  resolveMaxRequests: resolvePlanApiMaxRequests,
  keyGenerator: planApiRateLimitKey,
  message: 'API rate limit exceeded, please slow down your requests',
});

export async function applyPlanApiRateLimit(c: Context, next: Next) {
  if (!env.RATE_LIMIT_ENABLED) {
    return next();
  }
  return planApiRateLimiter(c, next);
}

export const sensitiveRateLimiter = createRateLimiter({
  namespace: 'sensitive',
  windowMs: 60 * 60 * 1000,
  maxRequests: env.RATE_LIMIT_SENSITIVE_MAX,
  message: 'Rate limit exceeded for sensitive operations',
});

export function createDeploymentRateLimiter() {
  return createRateLimiter({
    namespace: 'deployment',
    windowMs: 60 * 60 * 1000,
    maxRequests: env.RATE_LIMIT_DEPLOY_TRIGGER_MAX,
    keyGenerator: (c) => {
      const projectId = c.req.param('projectId') || c.req.param('id');
      return projectId ? `deployment:${projectId}` : getClientIp(c);
    },
    message: 'Too many deployments, please wait before triggering another',
  });
}

export const webhookRateLimiter = createRateLimiter({
  namespace: 'webhook',
  windowMs: 60 * 1000,
  maxRequests: env.RATE_LIMIT_WEBHOOK_MAX,
  keyGenerator: (c) => {
    const projectId = c.req.param('projectId');
    return projectId ? `webhook:${projectId}` : getClientIp(c);
  },
  message: 'Webhook rate limit exceeded',
});

export { getClientIp };
