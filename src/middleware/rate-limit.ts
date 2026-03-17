import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Rate limit configuration
export interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
  keyGenerator?: (c: Context) => string; // Custom key generator
  skip?: (c: Context) => boolean; // Skip rate limiting for certain requests
  message?: string; // Custom error message
}

// Rate limit entry
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store for rate limiting
// In production, consider using Redis for distributed rate limiting
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup old entries periodically (every 5 minutes)
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

/**
 * Get client IP address from request
 */
function getClientIp(c: Context): string {
  // Check common proxy headers
  const xForwardedFor = c.req.header('x-forwarded-for');
  if (xForwardedFor) {
    // x-forwarded-for can contain multiple IPs, take the first one
    return xForwardedFor.split(',')[0].trim();
  }

  const xRealIp = c.req.header('x-real-ip');
  if (xRealIp) {
    return xRealIp;
  }

  // Fallback to connection info (may not work in all environments)
  return c.req.header('cf-connecting-ip') || 'unknown';
}

/**
 * Default key generator - uses IP address
 */
function defaultKeyGenerator(c: Context): string {
  return getClientIp(c);
}

/**
 * Create a rate limiting middleware
 */
export function createRateLimiter(config: RateLimitConfig) {
  const {
    windowMs,
    maxRequests,
    keyGenerator = defaultKeyGenerator,
    skip,
    message = 'Too many requests, please try again later',
  } = config;

  return async function rateLimitMiddleware(c: Context, next: Next) {
    // Check if we should skip rate limiting
    if (skip && skip(c)) {
      return next();
    }

    const key = keyGenerator(c);
    const now = Date.now();

    // Get or create rate limit entry
    let entry = rateLimitStore.get(key);

    if (!entry || entry.resetAt < now) {
      // Create new entry
      entry = {
        count: 0,
        resetAt: now + windowMs,
      };
    }

    // Increment request count
    entry.count++;
    rateLimitStore.set(key, entry);

    // Calculate remaining requests and reset time
    const remaining = Math.max(0, maxRequests - entry.count);
    const resetInSeconds = Math.ceil((entry.resetAt - now) / 1000);

    // Set rate limit headers
    c.header('X-RateLimit-Limit', maxRequests.toString());
    c.header('X-RateLimit-Remaining', remaining.toString());
    c.header('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000).toString());
    c.header('Retry-After', resetInSeconds.toString());

    // Check if rate limit exceeded
    if (entry.count > maxRequests) {
      throw new HTTPException(429, {
        message,
      });
    }

    await next();
  };
}

// ============ Pre-configured Rate Limiters ============

/**
 * Strict rate limiter for authentication endpoints
 * 20 requests per minute per IP
 */
export const authRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 20,
  message: 'Too many authentication attempts, please try again in a minute',
});

/**
 * Rate limiter for password reset
 * 3 requests per 15 minutes per IP
 */
export const passwordResetRateLimiter = createRateLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  maxRequests: 3,
  message: 'Too many password reset requests, please try again later',
});

/**
 * Standard API rate limiter
 * 100 requests per minute per IP
 */
export const apiRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 100,
  message: 'API rate limit exceeded, please slow down your requests',
});

/**
 * Generous rate limiter for general endpoints
 * 200 requests per minute per IP
 */
export const generalRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 200,
});

/**
 * Very strict rate limiter for sensitive operations
 * 10 requests per hour per IP
 */
export const sensitiveRateLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequests: 10,
  message: 'Rate limit exceeded for sensitive operations',
});

/**
 * Rate limiter for deployment triggers
 * 20 deployments per hour per project
 */
export function createDeploymentRateLimiter() {
  return createRateLimiter({
    windowMs: 60 * 60 * 1000, // 1 hour
    maxRequests: 20,
    keyGenerator: (c) => {
      // Use project ID as key if available, otherwise use IP
      const projectId = c.req.param('projectId') || c.req.param('id');
      return projectId ? `deployment:${projectId}` : getClientIp(c);
    },
    message: 'Too many deployments, please wait before triggering another',
  });
}

/**
 * Rate limiter for webhook endpoints
 * 60 requests per minute per project
 */
export const webhookRateLimiter = createRateLimiter({
  windowMs: 60 * 1000, // 1 minute
  maxRequests: 60,
  keyGenerator: (c) => {
    const projectId = c.req.param('projectId');
    return projectId ? `webhook:${projectId}` : getClientIp(c);
  },
  message: 'Webhook rate limit exceeded',
});

// Export for use
export { getClientIp };
