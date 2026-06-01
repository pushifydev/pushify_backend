import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { apiKeyService, hasScope } from '../services/apikey.service';
import { t, type SupportedLocale } from '../i18n';
import type { ApiKeyScope } from '../db/schema';
import { applyPlanApiRateLimit } from './rate-limit';

export const API_KEY_PREFIX = 'pk_live_';

/**
 * Extract bearer / API key token from Authorization, X-API-Key, or ?token=
 */
export function extractAuthToken(c: Context): string | null {
  const authHeader = c.req.header('Authorization');
  if (authHeader) {
    const bearer = authHeader.match(/^Bearer\s+(.+)$/i);
    if (bearer) {
      return bearer[1].trim();
    }
  }

  const apiKeyHeader = c.req.header('X-API-Key');
  if (apiKeyHeader?.trim()) {
    return apiKeyHeader.trim();
  }

  const queryToken = c.req.query('token');
  return queryToken?.trim() ?? null;
}

export function isApiKeyToken(token: string): boolean {
  return token.startsWith(API_KEY_PREFIX);
}

/**
 * Check if the request carries a Pushify API key (pk_live_...)
 */
export function isApiKeyAuth(authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = bearer ? bearer[1].trim() : authHeader.trim();
  return isApiKeyToken(token);
}

export function isApiKeyRequest(c: Context): boolean {
  const token = extractAuthToken(c);
  return !!token && isApiKeyToken(token);
}

/**
 * Middleware to authenticate requests using API keys
 * Sets userId, organizationId, and apiKey on context
 */
export async function apiKeyAuthMiddleware(c: Context, next: Next) {
  const locale: SupportedLocale = c.get('locale') || 'en';
  const token = extractAuthToken(c);

  if (!token) {
    throw new HTTPException(401, {
      message: t(locale, 'auth', 'missingAuthHeader'),
    });
  }

  if (!isApiKeyToken(token)) {
    throw new HTTPException(401, {
      message: t(locale, 'apiKeys', 'invalidKey'),
    });
  }

  const result = await apiKeyService.validate(token);

  if (!result) {
    throw new HTTPException(401, {
      message: t(locale, 'apiKeys', 'invalidKey'),
    });
  }

  c.set('userId', result.userId);
  c.set('organizationId', result.organizationId);
  c.set('apiKey', result.apiKey);
  c.set('isApiKeyAuth', true);

  await applyPlanApiRateLimit(c, next);
}

/**
 * Combined auth middleware factory (JWT + API key)
 */
export function createCombinedAuthMiddleware(
  jwtAuthMiddleware: (c: Context, next: Next) => Promise<void | Response>,
) {
  return async (c: Context, next: Next) => {
    if (isApiKeyRequest(c)) {
      return apiKeyAuthMiddleware(c, next);
    }
    return jwtAuthMiddleware(c, next);
  };
}

/**
 * Middleware factory to require specific scope(s)
 * Use after apiKeyAuthMiddleware
 */
export function requireScope(...requiredScopes: ApiKeyScope[]) {
  return async (c: Context, next: Next) => {
    const locale: SupportedLocale = c.get('locale') || 'en';
    const isApiKey = c.get('isApiKeyAuth');

    if (!isApiKey) {
      return next();
    }

    const apiKey = c.get('apiKey');
    if (!apiKey) {
      throw new HTTPException(401, {
        message: t(locale, 'apiKeys', 'invalidKey'),
      });
    }

    const hasRequiredScope = requiredScopes.some((scope) => hasScope(apiKey.scopes, scope));

    if (!hasRequiredScope) {
      throw new HTTPException(403, {
        message: t(locale, 'apiKeys', 'insufficientScope'),
      });
    }

    await next();
  };
}

/**
 * Block API key auth on interactive or highly sensitive routes (SSH keys, web terminal).
 */
export function rejectApiKeyAuth() {
  return async (c: Context, next: Next) => {
    if (c.get('isApiKeyAuth')) {
      const locale: SupportedLocale = c.get('locale') || 'en';
      throw new HTTPException(403, {
        message: t(locale, 'apiKeys', 'sessionOnly'),
      });
    }
    await next();
  };
}
