/**
 * GitHub App authentication.
 *
 * An App never holds a user's token. It signs a short JWT with its private key to prove it is
 * the App, then exchanges that for an **installation access token** scoped to the repositories
 * one account installed it on. Those tokens last an hour, so they are minted on demand and
 * cached until shortly before they expire.
 *
 * This replaces the model where every deploy borrowed the organisation owner's personal OAuth
 * token: an installation survives the person who created it, is scoped to chosen repositories
 * instead of all of them, and carries its own rate limit.
 */
import { SignJWT, importPKCS8 } from 'jose';
import { logger } from './logger';

const GITHUB_API_URL = 'https://api.github.com';

/** GitHub rejects a JWT older than 10 minutes; 9 leaves room for clock skew. */
const APP_JWT_TTL_SECONDS = 9 * 60;
/** Renew an installation token this long before GitHub expires it. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface GitHubAppConfig {
  appId: string;
  /** PKCS#8 PEM. GitHub hands out PKCS#1 ("BEGIN RSA PRIVATE KEY"); see `normalizePrivateKey`. */
  privateKey: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
  /** null when the installation covers every repository the account owns */
  repositorySelection: 'all' | 'selected' | null;
}

/**
 * Environments mangle multi-line secrets: `\n` often arrives escaped, and GitHub's download is
 * PKCS#1 while Web Crypto only imports PKCS#8. Normalising here keeps the rest of the code
 * from caring which form the operator pasted in.
 */
export function normalizePrivateKey(raw: string): string {
  const key = raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
  return key.trim();
}

export function isPkcs1(key: string): boolean {
  return key.includes('BEGIN RSA PRIVATE KEY');
}

/** A JWT that proves we are the App itself — the only credential that mints installation tokens. */
export async function createAppJwt(
  config: GitHubAppConfig,
  now: number = Date.now()
): Promise<string> {
  const key = normalizePrivateKey(config.privateKey);

  if (isPkcs1(key)) {
    // Converting PKCS#1 needs a DER rewrite; failing loudly beats signing with a broken key.
    throw new Error(
      'GITHUB_APP_PRIVATE_KEY is in PKCS#1 form. Convert it once with: ' +
        'openssl pkcs8 -topk8 -inform PEM -outform PEM -nocrypt -in app.pem -out app.pkcs8.pem'
    );
  }

  const issuedAt = Math.floor(now / 1000);
  const privateKey = await importPKCS8(key, 'RS256');

  return new SignJWT({})
    .setProtectedHeader({ alg: 'RS256' })
    // Backdated by a minute so a slightly fast clock does not produce a future-dated token.
    .setIssuedAt(issuedAt - 60)
    .setExpirationTime(issuedAt + APP_JWT_TTL_SECONDS)
    .setIssuer(config.appId)
    .sign(privateKey);
}

interface CacheEntry {
  token: string;
  expiresAt: Date;
  repositorySelection: 'all' | 'selected' | null;
}

const tokenCache = new Map<number, CacheEntry>();

export function cachedInstallationToken(
  installationId: number,
  now: number = Date.now()
): InstallationToken | null {
  const hit = tokenCache.get(installationId);
  if (!hit) return null;

  if (hit.expiresAt.getTime() - TOKEN_REFRESH_MARGIN_MS <= now) {
    tokenCache.delete(installationId);
    return null;
  }

  return { token: hit.token, expiresAt: hit.expiresAt, repositorySelection: hit.repositorySelection };
}

export function rememberInstallationToken(installationId: number, token: InstallationToken): void {
  tokenCache.set(installationId, {
    token: token.token,
    expiresAt: token.expiresAt,
    repositorySelection: token.repositorySelection,
  });
}

export function forgetInstallationToken(installationId: number): void {
  tokenCache.delete(installationId);
}

/** Testing seam: the suite swaps this for a stub instead of reaching GitHub. */
export type Fetcher = typeof fetch;

/**
 * Mint (or reuse) an installation access token. Callers should treat the result as short-lived
 * and never persist it — the installation id is the durable credential, not the token.
 */
export async function getInstallationToken(
  config: GitHubAppConfig,
  installationId: number,
  options: { fetcher?: Fetcher; now?: number; force?: boolean } = {}
): Promise<InstallationToken> {
  const now = options.now ?? Date.now();

  if (!options.force) {
    const cached = cachedInstallationToken(installationId, now);
    if (cached) return cached;
  }

  const jwt = await createAppJwt(config, now);
  const doFetch = options.fetcher ?? fetch;

  const response = await doFetch(
    `${GITHUB_API_URL}/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    logger.warn(
      { installationId, status: response.status, body: body.slice(0, 400) },
      'GitHub installation token request failed'
    );

    // 404 means the installation is gone (uninstalled or transferred); 401 means our key is wrong.
    throw new Error(
      response.status === 404
        ? `GitHub App installation ${installationId} no longer exists`
        : `Could not mint a GitHub installation token (HTTP ${response.status})`
    );
  }

  const payload = (await response.json()) as {
    token: string;
    expires_at: string;
    repository_selection?: 'all' | 'selected';
  };

  const minted: InstallationToken = {
    token: payload.token,
    expiresAt: new Date(payload.expires_at),
    repositorySelection: payload.repository_selection ?? null,
  };

  rememberInstallationToken(installationId, minted);
  return minted;
}

/** A clone URL that carries the installation token, the form git expects for an App. */
export function installationCloneUrl(repoUrl: string, token: string): string {
  const url = new URL(repoUrl);
  url.username = 'x-access-token';
  url.password = token;
  return url.toString();
}
