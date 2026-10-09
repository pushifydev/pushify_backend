/**
 * Minimal Infisical client: log in with a machine identity (Universal Auth) and read the
 * secrets of one environment and path. Used only at deploy time; nothing it returns is stored.
 *
 * API: POST /api/v1/auth/universal-auth/login → { accessToken }
 *      GET  /api/v3/secrets/raw?workspaceId=&environment=&secretPath= → { secrets: [{ secretKey, secretValue }] }
 */
import { assertPublicUrl } from './ssrf-guard';

export const INFISICAL_DEFAULT_SITE_URL = 'https://app.infisical.com';
const REQUEST_TIMEOUT_MS = 15_000;

export interface InfisicalConnection {
  /** `https://app.infisical.com`, `https://eu.infisical.com` or a self-hosted instance */
  siteUrl: string;
  clientId: string;
  clientSecret: string;
  /** Infisical project (workspace) id */
  workspaceId: string;
  /** Environment slug: `prod`, `staging`, `dev`… */
  environment: string;
  /** Folder, `/` for the root */
  secretPath: string;
}

export interface InfisicalClientDeps {
  fetch?: typeof fetch;
  /** Refuses private/internal addresses; replaceable in tests */
  assertUrl?: (url: string) => Promise<unknown>;
}

export function normalizeSiteUrl(raw: string | undefined | null): string {
  const value = (raw ?? '').trim() || INFISICAL_DEFAULT_SITE_URL;
  return value.replace(/\/+$/, '');
}

export function normalizeSecretPath(raw: string | undefined | null): string {
  const value = (raw ?? '').trim() || '/';
  const withSlash = value.startsWith('/') ? value : `/${value}`;
  return withSlash.length > 1 ? withSlash.replace(/\/+$/, '') : withSlash;
}

/** A problem with the connection settings, or null. Checked before anything is stored. */
export function validateInfisicalConnection(input: Partial<InfisicalConnection>): string | null {
  let url: URL;
  try {
    url = new URL(normalizeSiteUrl(input.siteUrl));
  } catch {
    return 'Infisical URL is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'Infisical URL must use https';
  if (!input.clientId?.trim()) return 'Client ID is required';
  if (!input.clientSecret) return 'Client secret is required';
  if (!input.workspaceId?.trim()) return 'Infisical project ID is required';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.environment?.trim() ?? '')) {
    return 'Environment slug is required (e.g. prod, staging, dev)';
  }
  if (!/^\/[A-Za-z0-9_\-/.]*$/.test(normalizeSecretPath(input.secretPath))) {
    return 'Secret path may contain only letters, digits, "/", "_", "-" and "."';
  }
  if ((input.clientId?.length ?? 0) > 255 || (input.workspaceId?.length ?? 0) > 255) {
    return 'Client ID or project ID is too long';
  }
  return null;
}

async function request(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  what: string
): Promise<unknown> {
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    throw new Error(`Infisical could not be reached (${what})`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Infisical rejected the credentials (${what}, HTTP ${res.status})`);
  }
  if (res.status === 404) {
    throw new Error(`Infisical project, environment or path not found (${what}, HTTP 404)`);
  }
  if (!res.ok) {
    throw new Error(`Infisical returned HTTP ${res.status} (${what})`);
  }
  try {
    return await res.json();
  } catch {
    throw new Error(`Infisical returned an unreadable response (${what})`);
  }
}

/** Every secret of the connection's environment and path, keyed by name. */
export async function fetchInfisicalSecrets(
  connection: InfisicalConnection,
  deps: InfisicalClientDeps = {}
): Promise<Record<string, string>> {
  const doFetch = deps.fetch ?? fetch;
  const assertUrl = deps.assertUrl ?? assertPublicUrl;
  const siteUrl = normalizeSiteUrl(connection.siteUrl);
  try {
    await assertUrl(siteUrl);
  } catch (err) {
    throw new Error(`Infisical URL is not allowed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const login = (await request(
    doFetch,
    `${siteUrl}/api/v1/auth/universal-auth/login`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: connection.clientId, clientSecret: connection.clientSecret }),
      redirect: 'error',
    },
    'login'
  )) as { accessToken?: unknown };
  if (typeof login?.accessToken !== 'string' || !login.accessToken) {
    throw new Error('Infisical login returned no access token');
  }

  const params = new URLSearchParams({
    workspaceId: connection.workspaceId,
    environment: connection.environment,
    secretPath: normalizeSecretPath(connection.secretPath),
  });
  const body = (await request(
    doFetch,
    `${siteUrl}/api/v3/secrets/raw?${params.toString()}`,
    { method: 'GET', headers: { Authorization: `Bearer ${login.accessToken}` }, redirect: 'error' },
    'read secrets'
  )) as { secrets?: unknown };
  if (!Array.isArray(body?.secrets)) {
    throw new Error('Infisical returned an unexpected response (read secrets)');
  }

  const secrets: Record<string, string> = {};
  for (const item of body.secrets as Array<{ secretKey?: unknown; secretValue?: unknown }>) {
    if (typeof item?.secretKey === 'string' && typeof item.secretValue === 'string') {
      secrets[item.secretKey] = item.secretValue;
    }
  }
  return secrets;
}
