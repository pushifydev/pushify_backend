import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression: BullMQ's connection parser used to drop the DB index from REDIS_URL, so staging
 * and production sharing one Redis host collided on the same queues — a staging worker could
 * consume a production deployment job. The db index MUST be honored.
 *
 * config/env is mocked so these tests are independent of the local .env (dotenv would
 * otherwise inject a real REDIS_URL) and of the schema's url() check for the unset case.
 */
const mockEnv = vi.hoisted(() => ({
  env: {} as { REDIS_URL?: string },
}));
vi.mock('../config/env', () => mockEnv);

import { getBullRedisConnection } from './redis-connection';

beforeEach(() => {
  mockEnv.env.REDIS_URL = undefined;
});

describe('getBullRedisConnection', () => {
  it('returns null when REDIS_URL is unset', () => {
    expect(getBullRedisConnection()).toBeNull();
  });

  it('defaults to db 0 for a bare URL', () => {
    mockEnv.env.REDIS_URL = 'redis://localhost:6379';
    expect(getBullRedisConnection()).toMatchObject({ host: 'localhost', port: 6379, db: 0 });
  });

  it('honors the db index in the URL path (staging isolation)', () => {
    mockEnv.env.REDIS_URL = 'redis://localhost:6379/1';
    expect(getBullRedisConnection()).toMatchObject({ db: 1 });
  });

  it('parses auth, host, port and db together', () => {
    mockEnv.env.REDIS_URL = 'redis://user:secret@redis.internal:6380/2';
    expect(getBullRedisConnection()).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      username: 'user',
      password: 'secret',
      db: 2,
    });
  });

  it('treats a trailing slash as db 0', () => {
    mockEnv.env.REDIS_URL = 'redis://localhost:6379/';
    expect(getBullRedisConnection()).toMatchObject({ db: 0 });
  });

  it('defaults the port when the URL omits it', () => {
    mockEnv.env.REDIS_URL = 'redis://localhost';
    expect(getBullRedisConnection()).toMatchObject({ port: 6379 });
  });
});
