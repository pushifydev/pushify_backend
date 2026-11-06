import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * An API key can be limited to a list of projects (`api_keys.project_ids`). A key still acts as
 * the member who created it, so what it may do is the member's access *and* the key's list: the
 * key never reaches more than its creator, and a project the creator loses is lost to the key too.
 *
 * Two places enforce the list:
 * - apiKeyAuthMiddleware lets a project-scoped key use the project API only
 *   (`/api/v1/projects…`, see `apiKeyProjectPathAccess`) and answers 404 for a project outside it.
 * - lib/member-project-scope intersects every project check and project list with the key's list,
 *   read here from the request's async context, so a project named in a body or a list endpoint
 *   is filtered the same way as for a restricted member.
 */

const apiKeyProjectScopeStore = new AsyncLocalStorage<{ projectIds: readonly string[] }>();

/** Normalised (lowercase, de-duplicated) form of a key's project list; null when it has none. */
export function normalizeApiKeyProjectIds(projectIds: readonly string[] | null | undefined): string[] | null {
  if (!projectIds) return null;
  return [...new Set(projectIds.map((id) => id.trim().toLowerCase()))];
}

/** Run `fn` (the rest of the request) limited to the key's projects; no-op for an unscoped key. */
export function runWithApiKeyProjectScope<T>(projectIds: readonly string[] | null | undefined, fn: () => T): T {
  const normalized = normalizeApiKeyProjectIds(projectIds);
  if (!normalized) return fn();
  return apiKeyProjectScopeStore.run({ projectIds: normalized }, fn);
}

/** The projects the current request's API key is limited to, or null (session, or unscoped key). */
export function currentApiKeyProjectIds(): readonly string[] | null {
  return apiKeyProjectScopeStore.getStore()?.projectIds ?? null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECTS_PREFIX = '/api/v1/projects';

export type ApiKeyProjectPathAccess = 'allowed' | 'outside_project_api' | 'project_not_in_scope';

/**
 * Which requests a project-scoped key may make, decided from the path before any handler runs:
 * - `GET /api/v1/projects` and `GET /api/v1/projects/overview`: lists, filtered to the key's projects
 * - `/api/v1/projects/<id>` and below: only for a project in the key's list (404 otherwise, as for
 *   a restricted member, so other projects cannot be probed)
 * - anything else (creating a project, servers, databases, organization, dashboard, …): refused
 */
export function apiKeyProjectPathAccess(
  method: string,
  path: string,
  projectIds: readonly string[],
): ApiKeyProjectPathAccess {
  if (path !== PROJECTS_PREFIX && !path.startsWith(`${PROJECTS_PREFIX}/`)) return 'outside_project_api';

  // '' (the list), '/overview', or '/<projectId>[/…]'
  const rest = path.slice(PROJECTS_PREFIX.length).replace(/\/+$/, '');
  if (rest === '' || rest === '/overview') {
    return ['GET', 'HEAD'].includes(method.toUpperCase()) ? 'allowed' : 'outside_project_api';
  }

  const segment = rest.split('/')[1] ?? '';
  if (!UUID_RE.test(segment)) return 'project_not_in_scope';

  const allowed = normalizeApiKeyProjectIds(projectIds) ?? [];
  return allowed.includes(segment.toLowerCase()) ? 'allowed' : 'project_not_in_scope';
}
