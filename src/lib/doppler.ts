/**
 * Minimal Doppler client: read every secret of one project config with an access token
 * (a service token scoped to the config, or a service account / personal token). Used only at
 * deploy time; nothing it returns is stored.
 *
 * API: GET https://api.doppler.com/v3/configs/config/secrets/download?project=&config=&format=json
 *      Authorization: Bearer <token> → { KEY: value, … }
 */

export const DOPPLER_API_URL = 'https://api.doppler.com';
const REQUEST_TIMEOUT_MS = 15_000;

export interface DopplerConnection {
  /** Access token — service token (`dp.st.…`), service account or personal token */
  token: string;
  /** Doppler project slug */
  project: string;
  /** Config slug: `prd`, `stg`, `dev`, `prd_eu`… */
  config: string;
}

export interface DopplerClientDeps {
  fetch?: typeof fetch;
}

/** A problem with the connection settings, or null. Checked before anything is stored. */
export function validateDopplerConnection(input: Partial<DopplerConnection>): string | null {
  const token = input.token ?? '';
  if (!token.trim()) return 'Doppler token is required';
  if (/\s/.test(token) || token.length > 1000) return 'Doppler token is not valid';
  if (!/^[A-Za-z0-9_.-]{1,255}$/.test(input.project?.trim() ?? '')) {
    return 'Doppler project is required (letters, digits, "_", "-" and ".")';
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.config?.trim() ?? '')) {
    return 'Doppler config is required (e.g. prd, stg, dev)';
  }
  return null;
}

/** Every secret of the connection's project config, keyed by name. */
export async function fetchDopplerSecrets(
  connection: DopplerConnection,
  deps: DopplerClientDeps = {}
): Promise<Record<string, string>> {
  const doFetch = deps.fetch ?? fetch;
  const params = new URLSearchParams({
    project: connection.project,
    config: connection.config,
    format: 'json',
  });

  let res: Response;
  try {
    res = await doFetch(`${DOPPLER_API_URL}/v3/configs/config/secrets/download?${params.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${connection.token}`, Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new Error('Doppler could not be reached');
  }
  if (res.status === 401) {
    throw new Error('Doppler rejected the token (HTTP 401) — check or rotate the Doppler token');
  }
  if (res.status === 403) {
    throw new Error('Doppler token has no access to this project or config (HTTP 403)');
  }
  if (res.status === 404) {
    throw new Error('Doppler project or config not found (HTTP 404)');
  }
  if (!res.ok) {
    throw new Error(`Doppler returned HTTP ${res.status}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('Doppler returned an unreadable response');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Doppler returned an unexpected response');
  }

  const secrets: Record<string, string> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value === 'string') secrets[key] = value;
  }
  return secrets;
}
