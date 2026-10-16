import { describe, it, expect, vi } from 'vitest';
import { fetchVaultSecrets, validateVaultConnection, type VaultConnection } from './vault';

const connection = (overrides: Partial<VaultConnection> = {}): VaultConnection => ({
  address: 'https://vault.example.com:8200',
  token: 'hvs.secret-token',
  mount: 'secret',
  path: 'apps/backend/prod',
  namespace: '',
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const allowAll = async () => undefined;
const asFetch = (mock: unknown) => mock as typeof fetch;

describe('validateVaultConnection', () => {
  it('accepts a complete connection and a default mount', () => {
    expect(validateVaultConnection(connection())).toBeNull();
    expect(validateVaultConnection(connection({ mount: '' }))).toBeNull();
    expect(validateVaultConnection(connection({ path: '/apps/web/', namespace: 'admin/team' }))).toBeNull();
  });

  it('rejects a missing or malformed address, token, mount, path or namespace', () => {
    expect(validateVaultConnection(connection({ address: '' }))).toMatch(/address is required/);
    expect(validateVaultConnection(connection({ address: 'not a url' }))).toMatch(/not a valid URL/);
    expect(validateVaultConnection(connection({ address: 'http://vault.example.com' }))).toMatch(/https/);
    expect(validateVaultConnection(connection({ token: '' }))).toMatch(/token is required/);
    expect(validateVaultConnection(connection({ token: 'hvs bad' }))).toMatch(/token is not valid/);
    expect(validateVaultConnection(connection({ mount: 'kv?x=1' }))).toMatch(/mount/);
    expect(validateVaultConnection(connection({ path: '' }))).toMatch(/secret path is required/);
    expect(validateVaultConnection(connection({ path: 'apps/../sys' }))).toMatch(/secret path/);
    expect(validateVaultConnection(connection({ namespace: 'a b' }))).toMatch(/namespace/);
  });
});

describe('fetchVaultSecrets', () => {
  it('reads the KV v2 secret with the token and namespace', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json(200, {
        data: {
          data: { STRIPE_KEY: 'sk_live_1', PORT: 8080, DEBUG: false, NESTED: { a: 1 } },
          metadata: { version: 3 },
        },
      })
    );

    const secrets = await fetchVaultSecrets(connection({ namespace: 'admin' }), {
      fetch: asFetch(fetchMock),
      assertUrl: allowAll,
    });

    expect(secrets).toEqual({ STRIPE_KEY: 'sk_live_1', PORT: '8080', DEBUG: 'false' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://vault.example.com:8200/v1/secret/data/apps/backend/prod');
    expect(init.headers['X-Vault-Token']).toBe('hvs.secret-token');
    expect(init.headers['X-Vault-Namespace']).toBe('admin');
    expect(init.redirect).toBe('error');
  });

  it('omits the namespace header when none is set', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { data: { data: {} } }));
    await fetchVaultSecrets(connection(), { fetch: asFetch(fetchMock), assertUrl: allowAll });
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('X-Vault-Namespace');
  });

  it('fails clearly on a bad token without echoing it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(403, { errors: ['permission denied'] }));
    const err = await fetchVaultSecrets(connection(), { fetch: asFetch(fetchMock), assertUrl: allowAll }).catch(
      (e) => e
    );
    expect(err.message).toMatch(/Vault rejected the token .* \(HTTP 403\)/);
    expect(err.message).not.toContain('secret-token');
  });

  it('reports a missing secret, a sealed Vault and an unreachable server', async () => {
    await expect(
      fetchVaultSecrets(connection(), { fetch: asFetch(vi.fn().mockResolvedValue(json(404, {}))), assertUrl: allowAll })
    ).rejects.toThrow('Vault secret not found: secret/apps/backend/prod (HTTP 404)');
    await expect(
      fetchVaultSecrets(connection(), { fetch: asFetch(vi.fn().mockResolvedValue(json(503, {}))), assertUrl: allowAll })
    ).rejects.toThrow(/sealed/);
    await expect(
      fetchVaultSecrets(connection(), {
        fetch: asFetch(vi.fn().mockRejectedValue(new TypeError('fetch failed'))),
        assertUrl: allowAll,
      })
    ).rejects.toThrow('Vault could not be reached');
  });

  it('rejects a response that is not a KV v2 secret', async () => {
    await expect(
      fetchVaultSecrets(connection(), {
        fetch: asFetch(vi.fn().mockResolvedValue(json(200, { data: { keys: ['a'] } }))),
        assertUrl: allowAll,
      })
    ).rejects.toThrow(/KV v2/);
  });

  it('refuses private addresses before sending the token', async () => {
    const fetchMock = vi.fn();
    await expect(
      fetchVaultSecrets(connection({ address: 'https://10.0.0.5:8200' }), {
        fetch: asFetch(fetchMock),
        assertUrl: async () => {
          throw new Error('private address');
        },
      })
    ).rejects.toThrow('Vault address is not allowed: private address');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
