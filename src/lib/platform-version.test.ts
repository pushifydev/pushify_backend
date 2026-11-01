import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

const envMock = vi.hoisted(() => ({ PUSHIFY_DISABLE_UPDATE_CHECK: false, REDIS_URL: undefined as string | undefined }));
vi.mock('../config/env', () => ({ env: envMock }));

import {
  getPlatformVersion,
  normalizeReleases,
  parseVersion,
  compareVersions,
  isSecurityRelease,
  readRunningVersion,
  GITHUB_RELEASES_URL,
  RELEASES_CACHE_KEY,
  RELEASES_CACHE_TTL_SEC,
  type PlatformVersionDeps,
} from './platform-version';

const release = (tag: string, extra: Record<string, unknown> = {}) => ({
  tag_name: tag,
  name: tag,
  html_url: `https://github.com/pushifydev/pushify_backend/releases/tag/${tag}`,
  published_at: '2026-10-25T12:00:00Z',
  draft: false,
  prerelease: false,
  body: "## What's Changed\n* fix: something small",
  ...extra,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** Same contract as getCachedJson: a hit skips the fetcher, a throwing fetcher stores nothing. */
function memoryCache() {
  const store = new Map<string, { value: string; ttl: number }>();
  const cache = async <T,>(key: string, ttl: number, fetcher: () => Promise<T>): Promise<T> => {
    const hit = store.get(key);
    if (hit) return JSON.parse(hit.value) as T;
    const value = await fetcher();
    store.set(key, { value: JSON.stringify(value), ttl });
    return value;
  };
  return { cache, store };
}

let fetchMock: ReturnType<typeof vi.fn>;
let assertUrl: ReturnType<typeof vi.fn>;
let mem: ReturnType<typeof memoryCache>;

const deps = (overrides: PlatformVersionDeps = {}): PlatformVersionDeps => ({
  fetch: fetchMock as unknown as typeof fetch,
  assertUrl,
  cache: mem.cache,
  disabled: false,
  currentVersion: '0.9.0',
  now: () => new Date('2026-11-01T08:00:00Z'),
  ...overrides,
});

beforeEach(() => {
  envMock.PUSHIFY_DISABLE_UPDATE_CHECK = false;
  fetchMock = vi.fn();
  assertUrl = vi.fn().mockResolvedValue(undefined);
  mem = memoryCache();
});

describe('getPlatformVersion', () => {
  it('reports an up-to-date install', async () => {
    fetchMock.mockResolvedValue(json(200, [release('v0.9.2'), release('v0.9.1', { body: '### Security\n- fix' })]));

    const status = await getPlatformVersion(deps({ currentVersion: '0.9.2' }));

    expect(status).toEqual({
      current: '0.9.2',
      latest: {
        version: '0.9.2',
        tag: 'v0.9.2',
        name: 'v0.9.2',
        url: 'https://github.com/pushifydev/pushify_backend/releases/tag/v0.9.2',
        publishedAt: '2026-10-25T12:00:00Z',
      },
      updateAvailable: false,
      // 0.9.1 was a security release, but this install already has it
      securityRelease: false,
      check: 'ok',
      checkedAt: '2026-11-01T08:00:00.000Z',
    });
  });

  it('reports an outdated install without a security release in between', async () => {
    fetchMock.mockResolvedValue(json(200, [release('v0.9.1'), release('v0.9.2'), release('v0.9.0')]));

    const status = await getPlatformVersion(deps({ currentVersion: '0.9.0' }));

    expect(status.latest?.version).toBe('0.9.2');
    expect(status.updateAvailable).toBe(true);
    expect(status.securityRelease).toBe(false);
    expect(status.check).toBe('ok');
  });

  it('flags a security release anywhere between the running and the latest version', async () => {
    fetchMock.mockResolvedValue(
      json(200, [release('v0.9.2'), release('v0.9.1', { body: '## [0.9.1] - 2026-10-25\n\n### Security\n- Fixed a gap.' })]),
    );

    const status = await getPlatformVersion(deps({ currentVersion: '0.9.0' }));

    expect(status.latest?.version).toBe('0.9.2');
    expect(status.updateAvailable).toBe(true);
    expect(status.securityRelease).toBe(true);
  });

  it('recognises the security mark in the tag, the title, a heading or the [security] marker', () => {
    expect(isSecurityRelease('v1.0.1-security', null, null)).toBe(true);
    expect(isSecurityRelease('v1.0.1', 'v1.0.1 (Security release)', null)).toBe(true);
    expect(isSecurityRelease('v1.0.1', null, '## Security\n- fix')).toBe(true);
    expect(isSecurityRelease('v1.0.1', null, '* 1.0.1  2026-10-25  [security]')).toBe(true);
    expect(isSecurityRelease('v1.0.1', 'v1.0.1', "## What's Changed\n* fix: bump securityheaders lib")).toBe(false);
  });

  it('answers with latest null when GitHub cannot be reached, and does not cache the failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const status = await getPlatformVersion(deps());

    expect(status).toEqual({
      current: '0.9.0',
      latest: null,
      updateAvailable: false,
      securityRelease: false,
      check: 'unavailable',
      checkedAt: null,
    });
    expect(mem.store.size).toBe(0);

    // The next request tries again
    fetchMock.mockResolvedValue(json(200, [release('v0.9.2')]));
    expect((await getPlatformVersion(deps())).check).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('treats an HTTP error, a non-list body or unreadable JSON as unavailable', async () => {
    for (const res of [
      json(403, { message: 'API rate limit exceeded' }),
      json(200, { message: 'Not Found' }),
      new Response('<html>', { status: 200 }),
    ]) {
      fetchMock.mockResolvedValueOnce(res);
      const status = await getPlatformVersion(deps());
      expect(status.latest).toBeNull();
      expect(status.check).toBe('unavailable');
    }
  });

  it('makes no request at all when the check is disabled', async () => {
    envMock.PUSHIFY_DISABLE_UPDATE_CHECK = true;
    const cache = vi.fn();

    const status = await getPlatformVersion({ fetch: fetchMock as unknown as typeof fetch, assertUrl, cache, currentVersion: '0.9.0' });

    expect(status).toEqual({
      current: '0.9.0',
      latest: null,
      updateAvailable: false,
      securityRelease: false,
      check: 'disabled',
      checkedAt: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assertUrl).not.toHaveBeenCalled();
    expect(cache).not.toHaveBeenCalled();
  });

  it('fetches only the fixed URL, through the SSRF guard, without redirects and with a timeout', async () => {
    fetchMock.mockResolvedValue(json(200, [release('v0.9.2')]));

    await getPlatformVersion(deps());

    expect(assertUrl).toHaveBeenCalledWith(GITHUB_RELEASES_URL);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(GITHUB_RELEASES_URL);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('does not fetch when the SSRF guard refuses the address', async () => {
    assertUrl.mockRejectedValue(new Error('Blocked private/internal address'));

    const status = await getPlatformVersion(deps());

    expect(fetchMock).not.toHaveBeenCalled();
    expect(status.check).toBe('unavailable');
  });

  it('caches the releases for 6 hours and serves repeat requests from the cache', async () => {
    fetchMock.mockResolvedValue(json(200, [release('v0.9.2')]));

    await getPlatformVersion(deps());
    const second = await getPlatformVersion(deps({ currentVersion: '0.9.2' }));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mem.store.get(RELEASES_CACHE_KEY)?.ttl).toBe(RELEASES_CACHE_TTL_SEC);
    expect(RELEASES_CACHE_TTL_SEC).toBe(21_600);
    expect(second.updateAvailable).toBe(false);
  });

  it('cannot compare an unknown running version, but still shows the latest', async () => {
    fetchMock.mockResolvedValue(json(200, [release('v0.9.2', { body: '### Security' })]));

    const status = await getPlatformVersion(deps({ currentVersion: null }));

    expect(status.latest?.version).toBe('0.9.2');
    expect(status.updateAvailable).toBe(false);
    expect(status.securityRelease).toBe(false);
  });
});

describe('normalizeReleases', () => {
  it('skips drafts, pre-releases and non-semver tags, sorts newest first and drops foreign links', () => {
    const releases = normalizeReleases([
      release('v0.9.1'),
      release('v1.0.0', { draft: true }),
      release('v0.10.0-rc.1', { prerelease: true }),
      release('nightly'),
      release('v0.10.0', { html_url: 'https://evil.example/phish' }),
    ]);

    expect(releases.map((r) => r.version)).toEqual(['0.10.0', '0.9.1']);
    expect(releases[0].url).toBeNull();
    expect(releases[1].url).toBe('https://github.com/pushifydev/pushify_backend/releases/tag/v0.9.1');
  });
});

describe('compareVersions', () => {
  const cmp = (a: string, b: string) => Math.sign(compareVersions(parseVersion(a)!, parseVersion(b)!));

  it('orders by semver, numerically and with pre-releases before their release', () => {
    expect(cmp('0.10.0', '0.9.2')).toBe(1);
    expect(cmp('v0.9.2', '0.9.2')).toBe(0);
    expect(cmp('0.2.0-beta.2', '0.2.0')).toBe(-1);
    expect(cmp('0.2.0-beta.10', '0.2.0-beta.9')).toBe(1);
    expect(parseVersion('latest')).toBeNull();
  });
});

describe('readRunningVersion', () => {
  it('reads the version from the backend package.json', () => {
    expect(readRunningVersion()).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
  });
});
