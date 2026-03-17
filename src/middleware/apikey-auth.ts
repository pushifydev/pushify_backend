import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { apiKeyService, hasScope } from '../services/apikey.service';
import { t, type SupportedLocale } from '../i18n';
import type { ApiKeyScope } from '../db/schema';

const API_KEY_PREFIX = 'pk_live_';

/**
 * Check if the authorization header contains an API key
 */
export function isApiKeyAuth(authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  const token = authHeader.replace('Bearer ', '');
  return token.startsWith(API_KEY_PREFIX);
}

/**
 * Middleware to authenticate requests using API keys
 * Sets userId, organizationId, and apiKey on context
 */
export async function apiKeyAuthMiddleware(c: Context, next: Next) {
  const locale: SupportedLocale = c.get('locale') || 'en';
  const authHeader = c.req.header('Authorization');

  if (!authHeader) {
    throw new HTTPException(401, {
      message: t(locale, 'auth', 'missingAuthHeader'),
    });
  }

  const token = authHeader.replace('Bearer ', '');

  if (!token.startsWith(API_KEY_PREFIX)) {
    throw new HTTPException(401, {
      message: t(locale, 'apiKeys', 'invalidKey'),
    });
  }

  // Validate the API key
  const result = await apiKeyService.validate(token);

  if (!result) {
    throw new HTTPException(401, {
      message: t(locale, 'apiKeys', 'invalidKey'),
    });
  }

  // Set context variables
  c.set('userId', result.userId);
  c.set('organizationId', result.organizationId);
  c.set('apiKey', result.apiKey);
  c.set('isApiKeyAuth', true);

  await next();
}

/**
 * Combined auth middleware that accepts both JWT tokens and API keys
 * Prefers JWT if both are present
 */
export function createCombinedAuthMiddleware(jwtAuthMiddleware: (c: Context, next: Next) => Promise<void>) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (isApiKeyAuth(authHeader)) {
      // Use API key auth
      return apiKeyAuthMiddleware(c, next);
    } else {
      // Use JWT auth
      return jwtAuthMiddleware(c, next);
    }
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

    // If not API key auth (e.g., JWT), allow all
    if (!isApiKey) {
      return next();
    }

    const apiKey = c.get('apiKey');
    if (!apiKey) {
      throw new HTTPException(401, {
        message: t(locale, 'apiKeys', 'invalidKey'),
      });
    }

    // Check if the key has any of the required scopes
    const hasRequiredScope = requiredScopes.some((scope) => hasScope(apiKey.scopes, scope));

    if (!hasRequiredScope) {
      throw new HTTPException(403, {
        message: t(locale, 'apiKeys', 'insufficientScope'),
      });
    }

    await next();
  };
}
