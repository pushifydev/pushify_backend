import { describe, it, expect, vi } from 'vitest';
import { fetchDopplerSecrets, validateDopplerConnection, type DopplerConnection } from './doppler';

const connection = (overrides: Partial<DopplerConnection> = {}): DopplerConnection => ({
  token: 'dp.st.prd.secret-token',
  project: 'backend',
  config: 'prd',
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('validateDopplerConnection', () => {
  it('accepts a complete connection', () => {
    expect(validateDopplerConnection(connection())).toBeNull();
  });

  it('rejects a missing or malformed token, project or config', () => {
    expect(validateDopplerConnection(connection({ token: '' }))).toMatch(/token is required/);
    expect(validateDopplerConnection(connection({ token: 'dp st' }))).toMatch(/token is not valid/);
    expect(validateDopplerConnection(connection({ project: ' ' }))).toMatch(/project/);
    expect(validateDopplerConnection(connection({ config: 'prd/eu' }))).toMatch(/config/);
  });
});

describe('fetchDopplerSecrets', () => {
  it('downloads the project config with the bearer token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(json(200, { STRIPE_KEY: 'sk_live_1', DOPPLER_CONFIG: 'prd', ODD: 42 }));

    const secrets = await fetchDopplerSecrets(connection(), { fetch: fetchMock as unknown as typeof fetch });

    expect(secrets).toEqual({ STRIPE_KEY: 'sk_live_1', DOPPLER_CONFIG: 'prd' });
    const [rawUrl, init] = fetchMock.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.origin).toBe('https://api.doppler.com');
    expect(url.pathname).toBe('/v3/configs/config/secrets/download');
    expect(url.searchParams.get('project')).toBe('backend');
    expect(url.searchParams.get('config')).toBe('prd');
    expect(url.searchParams.get('format')).toBe('json');
    expect(init.headers.Authorization).toBe('Bearer dp.st.prd.secret-token');
    expect(init.redirect).toBe('error');
  });

  it('fails clearly on a bad token without echoing it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(401, { messages: ['Invalid Auth token'] }));
    const err = await fetchDopplerSecrets(connection(), { fetch: fetchMock as unknown as typeof fetch }).catch(
      (e) => e
    );
    expect(err.message).toMatch(/Doppler rejected the token \(HTTP 401\)/);
    expect(err.message).not.toContain('secret-token');
  });

  it('reports missing access, missing config and an unreachable API', async () => {
    await expect(
      fetchDopplerSecrets(connection(), {
        fetch: vi.fn().mockResolvedValue(json(403, {})) as unknown as typeof fetch,
      })
    ).rejects.toThrow(/no access to this project or config/);
    await expect(
      fetchDopplerSecrets(connection(), {
        fetch: vi.fn().mockResolvedValue(json(404, {})) as unknown as typeof fetch,
      })
    ).rejects.toThrow('Doppler project or config not found (HTTP 404)');
    await expect(
      fetchDopplerSecrets(connection(), {
        fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch,
      })
    ).rejects.toThrow('Doppler could not be reached');
  });

  it('rejects a response that is not a key/value object', async () => {
    await expect(
      fetchDopplerSecrets(connection(), {
        fetch: vi.fn().mockResolvedValue(json(200, ['x'])) as unknown as typeof fetch,
      })
    ).rejects.toThrow('Doppler returned an unexpected response');
  });
});
