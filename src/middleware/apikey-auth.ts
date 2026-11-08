import { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { apiKeyService, hasScope } from '../services/apikey.service';
import { t, type SupportedLocale } from '../i18n';
import type { ApiKeyScope } from '../db/schema';
import { applyPlanApiRateLimit } from './rate-limit';
import { runWithAuditApiKey } from '../lib/audit';
import { apiKeyProjectPathAccess, runWithApiKeyProjectScope } from '../lib/api-key-project-scope';
import {
  isOrganizationTwoFactorRequired,
  orgTwoFactorRequiredError,
  recordOrgTwoFactorDenial,
  userHasTwoFactorEnabled,
} from '../lib/org-two-factor';

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
  // Already verified by an earlier auth middleware on a shared route prefix (see authMiddleware)
  if (c.get('authVerified')) {
    return next();
  }

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

  // Organization-wide 2FA (lib/org-two-factor): a key acts as its creator, so while the key's
  // organization requires 2FA and the creator has none, every request with it is refused. No route
  // is exempt (a key cannot set up 2FA or switch organization). The key is not revoked: it works
  // again once the creator enables 2FA or the policy is turned off.
  if (
    (await isOrganizationTwoFactorRequired(result.organizationId)) &&
    !(await userHasTwoFactorEnabled(result.userId))
  ) {
    await recordOrgTwoFactorDenial({
      organizationId: result.organizationId,
      userId: result.userId,
      accessPath: 'api_key',
      method: c.req.method,
      path: c.req.path,
      apiKey: { id: result.apiKey.id, name: result.apiKey.name },
      ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
      userAgent: c.req.header('user-agent'),
    });
    throw orgTwoFactorRequiredError(locale);
  }

  // A key limited to projects only reaches the project API, and only for its own projects
  // (lib/api-key-project-scope); a project outside the list is not found, as for a restricted member.
  const projectIds = result.apiKey.projectIds ?? null;
  if (projectIds) {
    const access = apiKeyProjectPathAccess(c.req.method, c.req.path, projectIds);
    if (access === 'project_not_in_scope') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }
    if (access === 'outside_project_api') {
      throw new HTTPException(403, { message: t(locale, 'apiKeys', 'projectScoped') });
    }
  }

  c.set('userId', result.userId);
  c.set('organizationId', result.organizationId);
  c.set('apiKey', result.apiKey);
  c.set('isApiKeyAuth', true);
  c.set('authVerified', true);

  // Audit entries written while handling this request record which key made it (id + name), and
  // every project check made while handling it is limited to the key's projects.
  await runWithAuditApiKey(result.apiKey, () =>
    runWithApiKeyProjectScope(projectIds, () => applyPlanApiRateLimit(c, next)),
  );
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

/**
 * API-key scope by HTTP method: reads need `read`, anything else needs `write`. For routers that
 * share a path prefix, mount it on the router's own paths, never on '*' (a sub-router's '*'
 * middleware applies to every route under the shared prefix).
 */
export function requireScopeByMethod(read: ApiKeyScope, write: ApiKeyScope) {
  const readCheck = requireScope(read);
  const writeCheck = requireScope(write);
  return async (c: Context, next: Next) => {
    const m = c.req.method.toUpperCase();
    return (m === 'GET' || m === 'HEAD' ? readCheck : writeCheck)(c, next);
  };
}
