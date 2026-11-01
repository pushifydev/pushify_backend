import { readFileSync } from 'fs';
import path from 'path';
import { env } from '../config/env';
import { assertPublicUrl } from './ssrf-guard';
import { getCachedJson } from './read-through-cache';
import { logger } from './logger';

/**
 * Is this install behind the latest Pushify release, and is a release it is missing a security
 * release? Read by the admin panel (GET /api/v1/admin/platform/version) so an operator finds out
 * without running `selfhost/update.sh --dry-run` by hand. Nothing is sent to anyone: no email, no
 * notification, the answer is only returned to the platform admin who asked.
 *
 * The latest version comes from the GitHub releases of this repository — one fixed URL, checked
 * against the SSRF guard, no redirects, a short timeout — and is cached in Redis for 6 hours.
 * PUSHIFY_DISABLE_UPDATE_CHECK=true stops the request altogether. A failed check never fails the
 * endpoint: `latest` is null and `check` says `unavailable`; a failure is not cached.
 */

export const GITHUB_RELEASES_URL = 'https://api.github.com/repos/pushifydev/pushify_backend/releases?per_page=100';
/** Release pages a release `url` may point at; anything else from the API is dropped. */
const RELEASE_PAGE_PREFIX = 'https://github.com/pushifydev/pushify_backend/releases/';
export const RELEASES_CACHE_KEY = 'cache:platform:releases:v1';
export const RELEASES_CACHE_TTL_SEC = 6 * 60 * 60;
export const RELEASES_FETCH_TIMEOUT_MS = 5_000;
const RELEASES_MAX_CHARS = 5_000_000;

export interface PlatformRelease {
  version: string;
  tag: string;
  name: string | null;
  url: string | null;
  publishedAt: string | null;
  /** Marked as a security release in its tag, name or notes */
  security: boolean;
}

export interface PlatformVersionStatus {
  /** Version this API runs (package.json), null when it cannot be read */
  current: string | null;
  /** Newest published release; null when the check is disabled, failed or found none */
  latest: Omit<PlatformRelease, 'security'> | null;
  updateAvailable: boolean;
  /** At least one release newer than `current` is a security release */
  securityRelease: boolean;
  check: 'ok' | 'disabled' | 'unavailable';
  /** When the releases were fetched from GitHub (ISO); null without a successful check */
  checkedAt: string | null;
}

interface CachedReleases {
  checkedAt: string;
  releases: PlatformRelease[];
}

export interface PlatformVersionDeps {
  fetch?: typeof fetch;
  assertUrl?: (url: string) => Promise<unknown>;
  /** Read-through cache; defaults to Redis (no cache without REDIS_URL) */
  cache?: <T>(key: string, ttlSec: number, fetcher: () => Promise<T>) => Promise<T>;
  disabled?: boolean;
  currentVersion?: string | null;
  now?: () => Date;
}

type Semver = { core: [number, number, number]; pre: string | null };

export function parseVersion(raw: string): Semver | null {
  const m = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** Semver order: negative when a < b. A pre-release sorts before its release (0.2.0-beta.1 < 0.2.0). */
export function compareVersions(a: Semver, b: Semver): number {
  for (let i = 0; i < 3; i++) {
    if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre.localeCompare(b.pre, 'en', { numeric: true });
}

/**
 * How a security release is recognised: "### Security" in the notes (the CHANGELOG convention in
 * SECURITY.md), the `[security]` marker update.sh prints, or the word in the tag or title.
 */
export function isSecurityRelease(tag: string, name: string | null, body: string | null): boolean {
  const word = /\bsecurity\b/i;
  if (word.test(tag) || (name !== null && word.test(name))) return true;
  if (!body) return false;
  return /^\s{0,3}#{1,6}\s*security\b/im.test(body) || /\[security\]/i.test(body);
}

let runningVersion: string | null | undefined;

/** `version` of the backend's package.json (copied into the image), else npm's env. */
export function readRunningVersion(): string | null {
  if (runningVersion !== undefined) return runningVersion;
  let version = process.env.npm_package_version || null;
  try {
    const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    if (pkg?.name === 'pushify-backend' && typeof pkg.version === 'string') version = pkg.version;
  } catch {
    /* not started from the app root — keep npm's value */
  }
  runningVersion = version;
  return version;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);

/** Published (not draft, not pre-release) releases with a semver tag, newest first. */
export function normalizeReleases(raw: unknown): PlatformRelease[] {
  if (!Array.isArray(raw)) throw new Error('GitHub releases response is not a list');
  const found: { parsed: Semver; release: PlatformRelease }[] = [];
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== 'object' || r.draft === true || r.prerelease === true) continue;
    const tag = str(r.tag_name);
    const parsed = tag ? parseVersion(tag) : null;
    if (!tag || !parsed) continue;
    const name = str(r.name);
    const url = str(r.html_url);
    found.push({
      parsed,
      release: {
        version: tag.replace(/^v/, ''),
        tag,
        name,
        url: url && url.startsWith(RELEASE_PAGE_PREFIX) ? url : null,
        publishedAt: str(r.published_at),
        security: isSecurityRelease(tag, name, str(r.body)),
      },
    });
  }
  found.sort((a, b) => compareVersions(b.parsed, a.parsed));
  return found.map((f) => f.release);
}

async function fetchReleases(doFetch: typeof fetch, assertUrl: (url: string) => Promise<unknown>, now: () => Date): Promise<CachedReleases> {
  await assertUrl(GITHUB_RELEASES_URL);
  const res = await doFetch(GITHUB_RELEASES_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'pushify-update-check',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(RELEASES_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub releases returned HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > RELEASES_MAX_CHARS) throw new Error('GitHub releases response is too large');
  return { checkedAt: now().toISOString(), releases: normalizeReleases(JSON.parse(text)) };
}

export async function getPlatformVersion(deps: PlatformVersionDeps = {}): Promise<PlatformVersionStatus> {
  const current = deps.currentVersion !== undefined ? deps.currentVersion : readRunningVersion();
  const base: PlatformVersionStatus = {
    current,
    latest: null,
    updateAvailable: false,
    securityRelease: false,
    check: 'disabled',
    checkedAt: null,
  };
  if (deps.disabled ?? env.PUSHIFY_DISABLE_UPDATE_CHECK) return base;

  const cache = deps.cache ?? getCachedJson;
  const now = deps.now ?? (() => new Date());
  let cached: CachedReleases;
  try {
    // A throw skips the cache write, so a failed check is retried on the next request.
    cached = await cache(RELEASES_CACHE_KEY, RELEASES_CACHE_TTL_SEC, () =>
      fetchReleases(deps.fetch ?? fetch, deps.assertUrl ?? assertPublicUrl, now),
    );
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'Update check: GitHub releases unavailable');
    return { ...base, check: 'unavailable' };
  }

  const [newest] = cached.releases;
  const running = current ? parseVersion(current) : null;
  const newer = running
    ? cached.releases.filter((r) => {
        const v = parseVersion(r.tag);
        return v !== null && compareVersions(v, running) > 0;
      })
    : [];
  return {
    current,
    latest: newest ? { version: newest.version, tag: newest.tag, name: newest.name, url: newest.url, publishedAt: newest.publishedAt } : null,
    updateAvailable: newer.length > 0,
    securityRelease: newer.some((r) => r.security),
    check: 'ok',
    checkedAt: cached.checkedAt,
  };
}
