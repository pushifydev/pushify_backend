import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyToken } from '../lib/jwt';
import { isApiKeyAuth, apiKeyAuthMiddleware } from './apikey-auth';

export async function authMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  // Support token from query param (for SSE connections)
  const queryToken = c.req.query('token');

  let token: string | null = null;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (queryToken) {
    token = queryToken;
  }

  if (!token) {
    throw new HTTPException(401, { message: 'Missing or invalid authorization header' });
  }

  try {
    const payload = await verifyToken(token);

    if (payload.type !== 'access') {
      throw new HTTPException(401, { message: 'Invalid token type' });
    }

    // Set user info in context
    c.set('userId', payload.sub);
    if (payload.org) {
      c.set('organizationId', payload.org);
    }

    await next();
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    throw new HTTPException(401, { message: 'Invalid or expired token' });
  }
}

// Optional auth - doesn't throw if no token
export async function optionalAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);

    try {
      const payload = await verifyToken(token);

      if (payload.type === 'access') {
        c.set('userId', payload.sub);
        if (payload.org) {
          c.set('organizationId', payload.org);
        }
      }
    } catch {
      // Ignore errors for optional auth
    }
  }

  await next();
}

// Combined auth - supports both JWT and API key authentication
export async function combinedAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header('Authorization');

  // Check if it's an API key
  if (isApiKeyAuth(authHeader)) {
    return apiKeyAuthMiddleware(c, next);
  }

  // Fall back to JWT auth
  return authMiddleware(c, next);
}
