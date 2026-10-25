import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The new-project wizard reads the env names a repository documents in .env.example (or
 * .env.sample / .env.template). Only names and "has a default" leave the service — never values,
 * since an example file can hold a real secret.
 */
vi.mock('../config/env', () => ({ env: { GITLAB_BASE_URL: 'https://gitlab.example.com' } }));
vi.mock('../db', () => ({ db: {} }));

import { githubService } from './github.service';
import { gitlabService } from './gitlab.service';
import { ENV_EXAMPLE_MAX_BYTES } from '../lib/env-example-keys';

const EXAMPLE = [
  '# Database',
  'DATABASE_URL=postgres://user:supersecret@db/app',
  'export STRIPE_SECRET_KEY=',
  'API_URL="https://api.example.com" # public',
  "EMPTY_QUOTED=''",
  '# COMMENTED_OUT=1',
].join('\n');

const EXPECTED_KEYS = [
  { key: 'DATABASE_URL', hasDefault: true },
  { key: 'STRIPE_SECRET_KEY', hasDefault: false },
  { key: 'API_URL', hasDefault: true },
  { key: 'EMPTY_QUOTED', hasDefault: false },
];

/** Serves `files` (keyed by a substring of the request URL) and 404s everything else. */
function serve(files: Record<string, string>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    const match = Object.keys(files).find((part) => url.includes(part));
    return match ? new Response(files[match]) : new Response('Not Found', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const requestedUrls = (fetchMock: ReturnType<typeof serve>) => fetchMock.mock.calls.map(([url]) => String(url));

function expectNoValues(result: unknown) {
  const json = JSON.stringify(result);
  expect(json).not.toContain('supersecret');
  expect(json).not.toContain('api.example.com');
  for (const entry of (result as { keys: object[] }).keys) {
    expect(Object.keys(entry).sort()).toEqual(['hasDefault', 'key']);
  }
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('githubService.detectEnvKeys', () => {
  it('lists the keys of .env.example on the chosen branch, without values', async () => {
    const fetchMock = serve({ '/contents/.env.example?': EXAMPLE });

    const result = await githubService.detectEnvKeys('token', 'acme', 'web', 'release/1.0');

    expect(result).toEqual({ source: '.env.example', keys: EXPECTED_KEYS });
    expectNoValues(result);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.github.com/repos/acme/web/contents/.env.example?ref=release%2F1.0');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('returns an empty list when the repository has no example file', async () => {
    const fetchMock = serve({});

    await expect(githubService.detectEnvKeys('token', 'acme', 'web')).resolves.toEqual({ source: null, keys: [] });
    expect(requestedUrls(fetchMock)).toEqual([
      'https://api.github.com/repos/acme/web/contents/.env.example?ref=main',
      'https://api.github.com/repos/acme/web/contents/.env.sample?ref=main',
      'https://api.github.com/repos/acme/web/contents/.env.template?ref=main',
    ]);
  });

  it('falls back to .env.sample, then .env.template', async () => {
    serve({ '/contents/.env.template?': 'FROM_TEMPLATE=1' });
    await expect(githubService.detectEnvKeys('token', 'acme', 'web')).resolves.toEqual({
      source: '.env.template',
      keys: [{ key: 'FROM_TEMPLATE', hasDefault: true }],
    });
  });

  it('reads the file from the monorepo root directory', async () => {
    const fetchMock = serve({ '/contents/apps/web/.env.example?': 'NEXT_PUBLIC_API=1' });

    await expect(githubService.detectEnvKeys('token', 'acme', 'mono', 'main', '/apps/web/')).resolves.toEqual({
      source: 'apps/web/.env.example',
      keys: [{ key: 'NEXT_PUBLIC_API', hasDefault: true }],
    });
    expect(requestedUrls(fetchMock)[0]).toBe(
      'https://api.github.com/repos/acme/mono/contents/apps/web/.env.example?ref=main'
    );
  });

  it(`ignores an example file larger than ${ENV_EXAMPLE_MAX_BYTES} bytes`, async () => {
    serve({ '/contents/.env.example?': `HUGE=${'x'.repeat(ENV_EXAMPLE_MAX_BYTES)}` });
    await expect(githubService.detectEnvKeys('token', 'acme', 'web')).resolves.toEqual({ source: null, keys: [] });
  });
});

describe('gitlabService.detectEnvKeys', () => {
  it('lists the keys of .env.example on the chosen branch, without values', async () => {
    const fetchMock = serve({ '/files/.env.example/raw?': EXAMPLE });

    const result = await gitlabService.detectEnvKeys('token', 42, 'develop');

    expect(result).toEqual({ source: '.env.example', keys: EXPECTED_KEYS });
    expectNoValues(result);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://gitlab.example.com/api/v4/projects/42/repository/files/.env.example/raw?ref=develop');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token');
  });

  it('returns an empty list when the project has no example file', async () => {
    const fetchMock = serve({});

    await expect(gitlabService.detectEnvKeys('token', 42)).resolves.toEqual({ source: null, keys: [] });
    expect(requestedUrls(fetchMock)).toEqual([
      'https://gitlab.example.com/api/v4/projects/42/repository/files/.env.example/raw?ref=main',
      'https://gitlab.example.com/api/v4/projects/42/repository/files/.env.sample/raw?ref=main',
      'https://gitlab.example.com/api/v4/projects/42/repository/files/.env.template/raw?ref=main',
    ]);
  });

  it('falls back to .env.sample', async () => {
    serve({ '/files/.env.sample/raw?': 'export FROM_SAMPLE=' });
    await expect(gitlabService.detectEnvKeys('token', 42)).resolves.toEqual({
      source: '.env.sample',
      keys: [{ key: 'FROM_SAMPLE', hasDefault: false }],
    });
  });

  it('reads the file from the monorepo root directory (path URL-encoded)', async () => {
    const fetchMock = serve({ '/files/services%2Fapi%2F.env.example/raw?': 'PORT=8080' });

    await expect(gitlabService.detectEnvKeys('token', 42, 'main', 'services/api')).resolves.toEqual({
      source: 'services/api/.env.example',
      keys: [{ key: 'PORT', hasDefault: true }],
    });
    expect(requestedUrls(fetchMock)[0]).toBe(
      'https://gitlab.example.com/api/v4/projects/42/repository/files/services%2Fapi%2F.env.example/raw?ref=main'
    );
  });

  it(`ignores an example file larger than ${ENV_EXAMPLE_MAX_BYTES} bytes`, async () => {
    serve({ '/files/.env.example/raw?': `HUGE=${'x'.repeat(ENV_EXAMPLE_MAX_BYTES)}` });
    await expect(gitlabService.detectEnvKeys('token', 42)).resolves.toEqual({ source: null, keys: [] });
  });
});
