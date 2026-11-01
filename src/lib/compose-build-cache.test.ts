import { describe, it, expect } from 'vitest';
import { composeBuildInputsHash, decideComposeBuild, type ComposeBuildBaseline } from './compose-build-cache';

const KEY = 'k'.repeat(64);
const COMMIT = 'a'.repeat(40);
const IMAGES = { 'pushify-shop-web': 'sha256:111', 'postgres:16': 'sha256:999' };

const previous = (overrides: Partial<ComposeBuildBaseline> = {}): ComposeBuildBaseline => ({
  status: 'running',
  commitHash: COMMIT,
  buildMetadata: { composeInputsHash: 'h1', composeImages: { ...IMAGES } },
  ...overrides,
});

const unchanged = {
  forceBuild: false,
  commitHash: COMMIT,
  inputsHash: 'h1',
  images: { ...IMAGES },
  previous: previous(),
};

describe('decideComposeBuild', () => {
  it('same commit, same build inputs, same images: the build is skipped', () => {
    expect(decideComposeBuild(unchanged)).toEqual({ build: false });
  });

  it('a stopped previous deploy (it finished and ran) still counts as successful', () => {
    expect(decideComposeBuild({ ...unchanged, previous: previous({ status: 'stopped' }) })).toEqual({ build: false });
  });

  it('a forced build always builds', () => {
    expect(decideComposeBuild({ ...unchanged, forceBuild: true })).toEqual({
      build: true,
      reason: 'a forced build was requested',
    });
  });

  it('no previous deploy builds', () => {
    expect(decideComposeBuild({ ...unchanged, previous: null })).toMatchObject({ build: true });
  });

  it.each(['failed', 'cancelled', 'pending', 'building', 'deploying'])('a previous deploy that is %s builds', (status) => {
    expect(decideComposeBuild({ ...unchanged, previous: previous({ status }) })).toEqual({
      build: true,
      reason: 'the previous deploy did not succeed',
    });
  });

  it('a new commit builds', () => {
    expect(decideComposeBuild({ ...unchanged, commitHash: 'b'.repeat(40) })).toEqual({ build: true, reason: 'a new commit' });
    expect(decideComposeBuild({ ...unchanged, commitHash: null })).toMatchObject({ build: true });
    expect(decideComposeBuild({ ...unchanged, previous: previous({ commitHash: null }) })).toMatchObject({ build: true });
  });

  it('a previous deploy from before the build inputs were recorded builds', () => {
    expect(decideComposeBuild({ ...unchanged, previous: previous({ buildMetadata: null }) })).toEqual({
      build: true,
      reason: 'the previous deploy recorded no build inputs',
    });
    // A forced deploy that failed before recording anything has only forceBuild
    expect(
      decideComposeBuild({ ...unchanged, previous: previous({ buildMetadata: { forceBuild: true } }) })
    ).toMatchObject({ build: true });
  });

  it('changed build inputs, or inputs that could not be worked out, build', () => {
    expect(decideComposeBuild({ ...unchanged, inputsHash: 'h2' })).toEqual({
      build: true,
      reason: 'the compose file or build settings changed',
    });
    expect(decideComposeBuild({ ...unchanged, inputsHash: null })).toMatchObject({ build: true });
  });

  it('an image missing on the server builds', () => {
    expect(decideComposeBuild({ ...unchanged, images: null })).toEqual({
      build: true,
      reason: 'an image of the stack is not on the server',
    });
    expect(decideComposeBuild({ ...unchanged, images: {} })).toMatchObject({ build: true });
  });

  it('images on the server that are not the ones the previous deploy ran build', () => {
    // The tag was rebuilt since (another stack or project with the same `image:`), or re-pulled
    expect(decideComposeBuild({ ...unchanged, images: { ...IMAGES, 'pushify-shop-web': 'sha256:other' } })).toEqual({
      build: true,
      reason: 'the images on the server are not the ones the previous deploy ran',
    });
    // A service was added or removed
    expect(decideComposeBuild({ ...unchanged, images: { 'pushify-shop-web': 'sha256:111' } })).toMatchObject({ build: true });
    expect(
      decideComposeBuild({ ...unchanged, images: { ...IMAGES, 'redis:7': 'sha256:777' } })
    ).toMatchObject({ build: true });
  });
});

const COMPOSE_YAML = 'services:\n  web:\n    build: .\n';

function resolved(options: { args?: string; dockerfile?: string; context?: string; env?: string; replicas?: number } = {}) {
  return `name: pushify-shop
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: ${options.env ?? 'one'}
  web:
    build:
      context: ${options.context ?? '/opt/pushify/apps/shop/repo'}
      dockerfile: ${options.dockerfile ?? 'Dockerfile'}
      args:
        NEXT_PUBLIC_API: ${options.args ?? 'https://api.example.com'}
    deploy:
      replicas: ${options.replicas ?? 1}
    environment:
      SECRET: ${options.env ?? 'one'}
`;
}

const hashOf = (resolvedConfig: string, overrides: { head?: string; composeYaml?: string } = {}) =>
  composeBuildInputsHash({ head: COMMIT, composeYaml: COMPOSE_YAML, resolvedConfig, ...overrides }, KEY);

describe('composeBuildInputsHash', () => {
  it('runtime variables and replicas do not change it', () => {
    const base = hashOf(resolved());
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(resolved({ env: 'two' }))).toBe(base);
    expect(hashOf(resolved({ replicas: 3 }))).toBe(base);
  });

  it('does not depend on key order in the resolved config', () => {
    const reordered = `services:
  web:
    environment:
      SECRET: one
    build:
      args:
        NEXT_PUBLIC_API: https://api.example.com
      dockerfile: Dockerfile
      context: /opt/pushify/apps/shop/repo
  db:
    image: postgres:16
name: pushify-shop
`;
    expect(hashOf(reordered)).toBe(hashOf(resolved()));
  });

  it('a build arg, the Dockerfile path or the build context changes it', () => {
    const base = hashOf(resolved());
    expect(hashOf(resolved({ args: 'https://api2.example.com' }))).not.toBe(base);
    expect(hashOf(resolved({ dockerfile: 'Dockerfile.prod' }))).not.toBe(base);
    expect(hashOf(resolved({ context: '/opt/pushify/apps/shop/repo/web' }))).not.toBe(base);
  });

  it('the commit and the compose file change it', () => {
    const base = hashOf(resolved());
    expect(hashOf(resolved(), { head: 'b'.repeat(40) })).not.toBe(base);
    expect(hashOf(resolved(), { composeYaml: `${COMPOSE_YAML}  worker:\n    build: ./worker\n` })).not.toBe(base);
  });

  it('is keyed: build args may hold secrets and the hash is stored', () => {
    const input = { head: COMMIT, composeYaml: COMPOSE_YAML, resolvedConfig: resolved() };
    expect(composeBuildInputsHash(input, KEY)).not.toBe(composeBuildInputsHash(input, 'x'.repeat(64)));
  });

  it('cannot be worked out — so the deploy builds — when something it needs is unknown', () => {
    expect(hashOf(resolved(), { head: '' })).toBeNull();
    expect(hashOf(resolved(), { head: 'fatal: not a git repository' })).toBeNull();
    expect(hashOf('services: [')).toBeNull();
    expect(hashOf('')).toBeNull();
    // Build secrets come from files or variables whose values are not hashed
    expect(
      hashOf(`services:
  web:
    build:
      context: .
      secrets:
        - npm_token
secrets:
  npm_token:
    environment: NPM_TOKEN
`)
    ).toBeNull();
  });
});
