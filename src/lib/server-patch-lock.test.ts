import { describe, it, expect, beforeEach } from 'vitest';
import type Redis from 'ioredis';
import {
  acquireServerPatchLock,
  releaseServerPatchLock,
  serverPatchLockKey,
  SERVER_PATCH_LOCK_TTL_SECONDS,
} from './server-patch-lock';

/** Enough of Redis for the lock: SET NX EX, GET, EXPIRE and the compare-and-delete script. */
function fakeRedis() {
  const values = new Map<string, string>();
  const ttls = new Map<string, number>();
  const redis = {
    set: async (key: string, value: string, ex: string, ttl: number, nx: string) => {
      expect([ex, nx]).toEqual(['EX', 'NX']);
      if (values.has(key)) return null;
      values.set(key, value);
      ttls.set(key, ttl);
      return 'OK';
    },
    get: async (key: string) => values.get(key) ?? null,
    expire: async (key: string, ttl: number) => {
      ttls.set(key, ttl);
      return 1;
    },
    eval: async (script: string, numKeys: number, key: string, token: string) => {
      expect(script).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
      expect(numKeys).toBe(1);
      if (values.get(key) !== token) return 0;
      values.delete(key);
      ttls.delete(key);
      return 1;
    },
  };
  return { redis: redis as unknown as Redis, values, ttls };
}

const S1 = 'server-1';
const S2 = 'server-2';

let r: ReturnType<typeof fakeRedis>;
beforeEach(() => {
  r = fakeRedis();
});

describe('server patch lock', () => {
  it('lets one run in per server, with a TTL', async () => {
    expect(await acquireServerPatchLock(S1, 'run-a', r.redis)).toBe(true);
    expect(r.values.get(serverPatchLockKey(S1))).toBe('run-a');
    expect(r.ttls.get(serverPatchLockKey(S1))).toBe(SERVER_PATCH_LOCK_TTL_SECONDS);

    expect(await acquireServerPatchLock(S1, 'run-b', r.redis)).toBe(false);
    // another server is not affected
    expect(await acquireServerPatchLock(S2, 'run-b', r.redis)).toBe(true);
  });

  it('the run that holds it can claim it again (the worker taking over from the API) and it is extended', async () => {
    await acquireServerPatchLock(S1, 'run-a', r.redis);
    r.ttls.set(serverPatchLockKey(S1), 5);
    expect(await acquireServerPatchLock(S1, 'run-a', r.redis)).toBe(true);
    expect(r.ttls.get(serverPatchLockKey(S1))).toBe(SERVER_PATCH_LOCK_TTL_SECONDS);
  });

  it('only the holder releases it', async () => {
    await acquireServerPatchLock(S1, 'run-a', r.redis);
    await releaseServerPatchLock(S1, 'run-b', r.redis);
    expect(await acquireServerPatchLock(S1, 'run-b', r.redis)).toBe(false);

    await releaseServerPatchLock(S1, 'run-a', r.redis);
    expect(await acquireServerPatchLock(S1, 'run-b', r.redis)).toBe(true);
  });

  it('releasing never throws', async () => {
    const broken = { eval: async () => { throw new Error('connection lost'); } } as unknown as Redis;
    await expect(releaseServerPatchLock(S1, 'run-a', broken)).resolves.toBeUndefined();
  });

  it('without Redis nothing can be locked', async () => {
    expect(await acquireServerPatchLock(S1, 'run-a', null)).toBe(false);
    await expect(releaseServerPatchLock(S1, 'run-a', null)).resolves.toBeUndefined();
  });
});
