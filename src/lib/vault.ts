/**
 * Minimal HashiCorp Vault client: read one KV v2 secret with a token. Every key of that secret
 * becomes referenceable as `{{vault.KEY}}`. Used only at deploy time; nothing it returns is stored.
 *
 * API: GET {address}/v1/{mount}/data/{path}
 *      X-Vault-Token: <token>, X-Vault-Namespace: <namespace> (Enterprise / HCP only)
 *      → { data: { data: { KEY: value, … }, metadata: { … } } }
 */
import { assertPublicUrl } from './ssrf-guard';

export const VAULT_DEFAULT_MOUNT = 'secret';
const REQUEST_TIMEOUT_MS = 15_000;

export interface VaultConnection {
  /** `https://vault.example.com:8200` or an HCP Vault address */
  address: string;
  /** Vault token (service or batch token with read access to the secret) */
  token: string;
  /** KV v2 mount, `secret` by default */
  mount: string;
  /** The secret's path inside the mount, e.g. `apps/backend/prod` */
  path: string;
  /** Vault Enterprise / HCP namespace, empty for none */
  namespace: string;
}

export interface VaultClientDeps {
  fetch?: typeof fetch;
  /** Refuses private/internal addresses; replaceable in tests */
  assertUrl?: (url: string) => Promise<unknown>;
}

export function normalizeVaultAddress(raw: string | undefined | null): string {
  return (raw ?? '').trim().replace(/\/+$/, '');
}

/** Strip surrounding slashes: `/secret/` → `secret`, `/apps/web/` → `apps/web`. */
export function normalizeVaultSegment(raw: string | undefined | null): string {
  return (raw ?? '').trim().replace(/^\/+|\/+$/g, '');
}

const SEGMENT = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/;

/** A problem with the connection settings, or null. Checked before anything is stored. */
export function validateVaultConnection(input: Partial<VaultConnection>): string | null {
  const address = normalizeVaultAddress(input.address);
  if (!address) return 'Vault address is required';
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return 'Vault address is not a valid URL';
  }
  if (url.protocol !== 'https:') return 'Vault address must use https';
  if (address.length > 500) return 'Vault address is too long';

  const token = input.token ?? '';
  if (!token.trim()) return 'Vault token is required';
  if (/\s/.test(token) || token.length > 1000) return 'Vault token is not valid';

  const mount = normalizeVaultSegment(input.mount) || VAULT_DEFAULT_MOUNT;
  if (!SEGMENT.test(mount) || mount.length > 255 || mount.split('/').includes('..')) {
    return 'Vault mount may contain only letters, digits, "/", "_", "-" and "."';
  }
  const path = normalizeVaultSegment(input.path);
  if (!path) return 'Vault secret path is required (e.g. apps/backend/prod)';
  if (!SEGMENT.test(path) || path.length > 499 || path.split('/').some((p) => p === '..' || p === '.')) {
    return 'Vault secret path may contain only letters, digits, "/", "_", "-" and "."';
  }
  const namespace = normalizeVaultSegment(input.namespace);
  if (namespace && (!SEGMENT.test(namespace) || namespace.length > 255)) {
    return 'Vault namespace may contain only letters, digits, "/", "_", "-" and "."';
  }
  return null;
}

/** Every key of the connection's KV v2 secret, keyed by name. */
export async function fetchVaultSecrets(
  connection: VaultConnection,
  deps: VaultClientDeps = {}
): Promise<Record<string, string>> {
  const doFetch = deps.fetch ?? fetch;
  const assertUrl = deps.assertUrl ?? assertPublicUrl;
  const address = normalizeVaultAddress(connection.address);
  try {
    await assertUrl(address);
  } catch (err) {
    throw new Error(`Vault address is not allowed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const mount = normalizeVaultSegment(connection.mount) || VAULT_DEFAULT_MOUNT;
  const path = normalizeVaultSegment(connection.path);
  const encode = (segment: string) => segment.split('/').map(encodeURIComponent).join('/');
  const headers: Record<string, string> = { 'X-Vault-Token': connection.token, Accept: 'application/json' };
  const namespace = normalizeVaultSegment(connection.namespace);
  if (namespace) headers['X-Vault-Namespace'] = namespace;

  let res: Response;
  try {
    res = await doFetch(`${address}/v1/${encode(mount)}/data/${encode(path)}`, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Vault could not be reached');
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `Vault rejected the token or it has no read access to ${mount}/${path} (HTTP ${res.status}) — check the token and its policy`
    );
  }
  if (res.status === 404) {
    throw new Error(`Vault secret not found: ${mount}/${path} (HTTP 404) — check the mount (KV v2) and path`);
  }
  if (res.status === 503) {
    throw new Error('Vault is sealed or unavailable (HTTP 503)');
  }
  if (!res.ok) {
    throw new Error(`Vault returned HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('Vault returned an unreadable response');
  }
  const data = (body as { data?: { data?: unknown } } | null)?.data?.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Vault returned an unexpected response — is the mount a KV v2 engine?');
  }

  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (typeof value === 'string') secrets[key] = value;
    else if (typeof value === 'number' || typeof value === 'boolean') secrets[key] = String(value);
  }
  return secrets;
}
