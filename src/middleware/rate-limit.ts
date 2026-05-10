import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { getOptionalRedis } from '../lib/redis-client';
import { redisFixedWindowHit } from '../lib/rate-limit-redis';
import { logger } from '../lib/logger';
import { env } from '../config/env';

export interface RateLimitConfig {
  /** Isolates counters between limiters (auth vs general, etc.) */
  namespace: string;
  windowMs: number;
  maxRequests: number;
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

function getClientIp(c: Context): string {
  const xForwardedFor = c.req.header('x-forwarded-for');
  if (xForwardedFor) {
    return xForwardedFor.split(',')[0].trim();
  }

  const xRealIp = c.req.header('x-real-ip');
  if (xRealIp) {
    return xRealIp;
  }

  return c.req.header('cf-connecting-ip') || 'unknown';
}

function defaultKeyGenerator(c: Context): string {
  return getClientIp(c);
}

export function createRateLimiter(config: RateLimitConfig) {
  const {
    namespace,
    windowMs,
    maxRequests,
    keyGenerator = defaultKeyGenerator,
    skip,
    message = 'Too many requests, please try again later',
  } = config;

  return async function rateLimitMiddleware(c: Context, next: Next) {
    if (skip?.(c)) {
      return next();
    }

    const clientKey = keyGenerator(c);
    const storeKey = `${namespace}:${clientKey}`;
    const redis = getOptionalRedis();

    if (redis) {
      try {
        const rlKey = `pushify:rl:${namespace}:${clientKey}`;
        const r = await redisFixedWindowHit(redis, rlKey, windowMs, maxRequests);
        const remaining = Math.max(0, maxRequests - r.count);
        const resetInSeconds = Math.max(0, Math.ceil((r.resetAtMs - Date.now()) / 1000));

        c.header('X-RateLimit-Limit', maxRequests.toString());
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

    const remaining = Math.max(0, maxRequests - entry.count);
    const resetInSeconds = Math.ceil((entry.resetAt - now) / 1000);

    c.header('X-RateLimit-Limit', maxRequests.toString());
    c.header('X-RateLimit-Remaining', remaining.toString());
    c.header('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000).toString());
    c.header('Retry-After', resetInSeconds.toString());

    if (entry.count > maxRequests) {
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

export const generalRateLimiter = createRateLimiter({
  namespace: 'general',
  windowMs: 60 * 1000,
  maxRequests: env.RATE_LIMIT_API_MAX,
});

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
