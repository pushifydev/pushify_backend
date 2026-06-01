import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { verifyToken } from '../lib/jwt';
import {
  apiKeyAuthMiddleware,
  extractAuthToken,
  isApiKeyRequest,
  isApiKeyToken,
} from './apikey-auth';
import { applyPlanApiRateLimit } from './rate-limit';
import { t, type SupportedLocale } from '../i18n';

export async function authMiddleware(c: Context, next: Next) {
  const locale: SupportedLocale = c.get('locale') || 'en';

  if (isApiKeyRequest(c)) {
    return apiKeyAuthMiddleware(c, next);
  }

  const token = extractAuthToken(c);

  if (!token) {
    throw new HTTPException(401, {
      message: t(locale, 'auth', 'missingAuthHeader'),
    });
  }

  if (isApiKeyToken(token)) {
    return apiKeyAuthMiddleware(c, next);
  }

  try {
    const payload = await verifyToken(token);

    if (payload.type !== 'access') {
      throw new HTTPException(401, { message: t(locale, 'auth', 'invalidTokenType') });
    }

    c.set('userId', payload.sub);
    if (payload.org) {
      c.set('organizationId', payload.org);
    }

    await applyPlanApiRateLimit(c, next);
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error;
    }
    throw new HTTPException(401, { message: t(locale, 'auth', 'invalidToken') });
  }
}

export async function optionalAuthMiddleware(c: Context, next: Next) {
  const token = extractAuthToken(c);

  if (token && !isApiKeyToken(token)) {
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

export async function combinedAuthMiddleware(c: Context, next: Next) {
  if (isApiKeyRequest(c)) {
    return apiKeyAuthMiddleware(c, next);
  }
  return authMiddleware(c, next);
}
