import { describe, it, expect, vi } from 'vitest';
import {
  fetchInfisicalSecrets,
  normalizeSecretPath,
  normalizeSiteUrl,
  validateInfisicalConnection,
  type InfisicalConnection,
} from './infisical';

const connection = (overrides: Partial<InfisicalConnection> = {}): InfisicalConnection => ({
  siteUrl: 'https://app.infisical.com',
  clientId: 'client-id',
  clientSecret: 'client-secret',
  workspaceId: 'ws-123',
  environment: 'prod',
  secretPath: '/',
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const allowAll = async () => undefined;

describe('normalizers', () => {
  it('defaults and trims the site URL', () => {
    expect(normalizeSiteUrl('')).toBe('https://app.infisical.com');
    expect(normalizeSiteUrl('https://eu.infisical.com/')).toBe('https://eu.infisical.com');
  });

  it('normalizes the secret path', () => {
    expect(normalizeSecretPath(undefined)).toBe('/');
    expect(normalizeSecretPath('backend/')).toBe('/backend');
  });
});

describe('validateInfisicalConnection', () => {
  it('accepts a complete connection', () => {
    expect(validateInfisicalConnection(connection())).toBeNull();
  });

  it('rejects missing fields, plain http and odd paths', () => {
    expect(validateInfisicalConnection(connection({ clientSecret: '' }))).toMatch(/Client secret/);
    expect(validateInfisicalConnection(connection({ workspaceId: ' ' }))).toMatch(/project ID/);
    expect(validateInfisicalConnection(connection({ environment: 'prod env' }))).toMatch(/Environment/);
    expect(validateInfisicalConnection(connection({ siteUrl: 'http://infisical.local' }))).toMatch(/https/);
    expect(validateInfisicalConnection(connection({ secretPath: '/a?b' }))).toMatch(/Secret path/);
  });
});

describe('fetchInfisicalSecrets', () => {
  it('logs in with Universal Auth and reads the environment and path', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(200, { accessToken: 'tok' }))
      .mockResolvedValueOnce(
        json(200, {
          secrets: [
            { secretKey: 'STRIPE_KEY', secretValue: 'sk_live_1' },
            { secretKey: 'BROKEN' },
          ],
        })
      );

    const secrets = await fetchInfisicalSecrets(connection({ secretPath: '/backend' }), {
      fetch: fetchMock as unknown as typeof fetch,
      assertUrl: allowAll,
    });

    expect(secrets).toEqual({ STRIPE_KEY: 'sk_live_1' });
    const [loginUrl, loginInit] = fetchMock.mock.calls[0];
    expect(loginUrl).toBe('https://app.infisical.com/api/v1/auth/universal-auth/login');
    expect(JSON.parse(loginInit.body)).toEqual({ clientId: 'client-id', clientSecret: 'client-secret' });
    const [readUrl, readInit] = fetchMock.mock.calls[1];
    const url = new URL(readUrl);
    expect(url.pathname).toBe('/api/v3/secrets/raw');
    expect(url.searchParams.get('workspaceId')).toBe('ws-123');
    expect(url.searchParams.get('environment')).toBe('prod');
    expect(url.searchParams.get('secretPath')).toBe('/backend');
    expect(readInit.headers.Authorization).toBe('Bearer tok');
  });

  it('reports rejected credentials without echoing them', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(401, { message: 'bad client-secret' }));
    const err = await fetchInfisicalSecrets(connection(), {
      fetch: fetchMock as unknown as typeof fetch,
      assertUrl: allowAll,
    }).catch((e) => e);
    expect(err.message).toBe('Infisical rejected the credentials (login, HTTP 401)');
    expect(err.message).not.toContain('client-secret');
  });

  it('reports an unreachable server and a missing project', async () => {
    await expect(
      fetchInfisicalSecrets(connection(), {
        fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')) as unknown as typeof fetch,
        assertUrl: allowAll,
      })
    ).rejects.toThrow('Infisical could not be reached (login)');

    const notFound = vi
      .fn()
      .mockResolvedValueOnce(json(200, { accessToken: 'tok' }))
      .mockResolvedValueOnce(json(404, {}));
    await expect(
      fetchInfisicalSecrets(connection(), { fetch: notFound as unknown as typeof fetch, assertUrl: allowAll })
    ).rejects.toThrow(/not found \(read secrets, HTTP 404\)/);
  });

  it('refuses a URL the SSRF guard blocks before sending the client secret', async () => {
    const fetchMock = vi.fn();
    await expect(
      fetchInfisicalSecrets(connection({ siteUrl: 'https://10.0.0.5' }), {
        fetch: fetchMock as unknown as typeof fetch,
        assertUrl: async () => {
          throw new Error('Blocked private/internal address');
        },
      })
    ).rejects.toThrow('Infisical URL is not allowed: Blocked private/internal address');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
