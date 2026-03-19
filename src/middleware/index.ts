import type { OpenAPIHono } from '@hono/zod-openapi';
import { cors } from 'hono/cors';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import { timing } from 'hono/timing';

import { loggerMiddleware } from './logger';
import { errorHandler } from './error-handler';
import { i18nMiddleware } from './i18n';
import { generalRateLimiter } from './rate-limit';
import { env } from '../config/env';

export function registerMiddleware(app: OpenAPIHono<any>) {
  // Request tracking
  app.use('*', requestId());
  app.use('*', timing());

  // Security
  app.use('*', secureHeaders());

  // i18n - detect locale from Accept-Language header
  app.use('*', i18nMiddleware);

  // Logging
  app.use('*', loggerMiddleware);

  // CORS
  app.use(
    '*',
    cors({
      origin: (origin) => {
        const allowed = [env.CORS_ORIGIN, env.FRONTEND_URL].filter(Boolean);
        if (!origin || allowed.includes(origin)) return origin;
        return null;
      },
      credentials: true,
      allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'Accept-Language'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 86400,
    })
  );

  // Body size limit (10MB)
  app.use('*', async (c, next) => {
    const contentLength = c.req.header('content-length');
    if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) {
      return c.json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large (max 10MB)' } }, 413);
    }
    await next();
  });

  // Global rate limiting (if enabled)
  if (env.RATE_LIMIT_ENABLED) {
    app.use('/api/*', generalRateLimiter);
  }

  // Error handler
  app.onError(errorHandler);
}

// Re-export middleware for direct use
export { authMiddleware, optionalAuthMiddleware, combinedAuthMiddleware } from './auth';
export { loggerMiddleware } from './logger';
export { errorHandler } from './error-handler';
export { i18nMiddleware, getLocale } from './i18n';
export {
  createRateLimiter,
  authRateLimiter,
  apiRateLimiter,
  generalRateLimiter,
  sensitiveRateLimiter,
  passwordResetRateLimiter,
  webhookRateLimiter,
  createDeploymentRateLimiter,
} from './rate-limit';
