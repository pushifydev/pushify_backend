import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPair, exportPKCS8, jwtVerify, decodeProtectedHeader } from 'jose';
import {
  cachedInstallationToken,
  createAppJwt,
  forgetInstallationToken,
  getInstallationToken,
  installationCloneUrl,
  isPkcs1,
  normalizePrivateKey,
  rememberInstallationToken,
} from './github-app-auth';

const APP_ID = '123456';
let privateKey = '';
let publicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey'];

beforeEach(async () => {
  if (!privateKey) {
    const pair = await generateKeyPair('RS256');
    privateKey = await exportPKCS8(pair.privateKey);
    publicKey = pair.publicKey;
  }
  forgetInstallationToken(42);
});

describe('normalizePrivateKey', () => {
  it('unescapes the newlines a .env file turns into backslash-n', () => {
    expect(normalizePrivateKey('-----BEGIN-----\\nline\\n-----END-----')).toBe(
      '-----BEGIN-----\nline\n-----END-----'
    );
  });

  it('leaves a real multi-line key alone', () => {
    const key = '-----BEGIN-----\nline\n-----END-----';
    expect(normalizePrivateKey(key)).toBe(key);
  });

  it('recognises the PKCS#1 form GitHub hands out', () => {
    expect(isPkcs1('-----BEGIN RSA PRIVATE KEY-----')).toBe(true);
    expect(isPkcs1('-----BEGIN PRIVATE KEY-----')).toBe(false);
  });
});

describe('createAppJwt', () => {
  it('signs an RS256 token issued by the app', async () => {
    const now = 1_700_000_000_000;
    const jwt = await createAppJwt({ appId: APP_ID, privateKey }, now);

    expect(decodeProtectedHeader(jwt).alg).toBe('RS256');

    // The token is deliberately signed at a fixed instant, so verify at that same instant.
    const { payload } = await jwtVerify(jwt, publicKey, {
      issuer: APP_ID,
      currentDate: new Date(now),
    });
    expect(payload.iss).toBe(APP_ID);
    // Backdated a minute so a fast clock cannot produce a future-dated token…
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
    // …and well inside GitHub's ten-minute ceiling.
    expect((payload.exp as number) - Math.floor(now / 1000)).toBeLessThanOrEqual(600);
  });

  it('refuses a PKCS#1 key with instructions instead of signing something broken', async () => {
    await expect(
      createAppJwt({ appId: APP_ID, privateKey: '-----BEGIN RSA PRIVATE KEY-----\nx\n-----END RSA PRIVATE KEY-----' })
    ).rejects.toThrow(/pkcs8/i);
  });
});

describe('installation token cache', () => {
  const token = (expiresAt: Date) => ({
    token: 'ghs_abc',
    expiresAt,
    repositorySelection: 'selected' as const,
  });

  it('returns a token that is still comfortably valid', () => {
    const now = Date.now();
    rememberInstallationToken(42, token(new Date(now + 60 * 60 * 1000)));
    expect(cachedInstallationToken(42, now)?.token).toBe('ghs_abc');
  });

  it('drops a token inside the refresh margin, before GitHub would reject it', () => {
    const now = Date.now();
    // Four minutes left is less than the five-minute margin.
    rememberInstallationToken(42, token(new Date(now + 4 * 60 * 1000)));
    expect(cachedInstallationToken(42, now)).toBeNull();
  });

  it('has nothing for an installation it has not seen', () => {
    expect(cachedInstallationToken(999)).toBeNull();
  });
});

describe('getInstallationToken', () => {
  const config = () => ({ appId: APP_ID, privateKey });

  const respond = (body: unknown, status = 201) =>
    vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    );

  it('mints a token and authenticates the request as the app', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fetcher = respond({ token: 'ghs_new', expires_at: expiresAt, repository_selection: 'selected' });

    const result = await getInstallationToken(config(), 42, { fetcher: fetcher as unknown as typeof fetch });

    expect(result.token).toBe('ghs_new');
    expect(result.repositorySelection).toBe('selected');

    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toContain('/app/installations/42/access_tokens');
    expect(init.method).toBe('POST');
    expect(String((init.headers as Record<string, string>).Authorization)).toMatch(/^Bearer eyJ/);
  });

  it('reuses the cached token instead of asking again', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fetcher = respond({ token: 'ghs_new', expires_at: expiresAt });

    await getInstallationToken(config(), 42, { fetcher: fetcher as unknown as typeof fetch });
    await getInstallationToken(config(), 42, { fetcher: fetcher as unknown as typeof fetch });

    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('mints again when forced', async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const fetcher = respond({ token: 'ghs_new', expires_at: expiresAt });

    await getInstallationToken(config(), 42, { fetcher: fetcher as unknown as typeof fetch });
    await getInstallationToken(config(), 42, { fetcher: fetcher as unknown as typeof fetch, force: true });

    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('says so plainly when the installation is gone', async () => {
    const fetcher = respond({ message: 'Not Found' }, 404);
    await expect(
      getInstallationToken(config(), 42, { fetcher: fetcher as unknown as typeof fetch })
    ).rejects.toThrow(/no longer exists/);
  });

  it('reports any other failure without leaking the response body', async () => {
    const fetcher = respond({ message: 'Bad credentials' }, 401);
    await expect(
      getInstallationToken(config(), 42, { fetcher: fetcher as unknown as typeof fetch })
    ).rejects.toThrow(/HTTP 401/);
  });

  it('does not cache a failed mint', async () => {
    const failing = respond({ message: 'boom' }, 500);
    await expect(
      getInstallationToken(config(), 42, { fetcher: failing as unknown as typeof fetch })
    ).rejects.toThrow();
    expect(cachedInstallationToken(42)).toBeNull();
  });
});

describe('installationCloneUrl', () => {
  it('embeds the token the way git expects for an app', () => {
    expect(installationCloneUrl('https://github.com/acme/site.git', 'ghs_abc')).toBe(
      'https://x-access-token:ghs_abc@github.com/acme/site.git'
    );
  });

  it('percent-encodes a token with URL-unsafe characters', () => {
    const url = installationCloneUrl('https://github.com/acme/site.git', 'gh s/abc');
    expect(url).toContain('x-access-token:');
    expect(url).not.toContain('gh s/abc');
  });
});
