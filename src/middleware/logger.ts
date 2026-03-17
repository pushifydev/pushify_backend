import type { Context, Next } from 'hono';
import { logger } from '../lib/logger';

export async function loggerMiddleware(c: Context, next: Next) {
  const start = Date.now();
  const requestId = c.get('requestId');

  logger.info({
    type: 'request',
    requestId,
    method: c.req.method,
    path: c.req.path,
    userAgent: c.req.header('user-agent'),
  });

  await next();

  const duration = Date.now() - start;

  logger.info({
    type: 'response',
    requestId,
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration: `${duration}ms`,
  });
}
