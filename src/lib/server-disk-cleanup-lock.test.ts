import { describe, it, expect, beforeEach } from 'vitest';
import type Redis from 'ioredis';
import {
  acquireServerDiskCleanupLock,
  releaseServerDiskCleanupLock,
  serverDiskCleanupLockKey,
  waitForServerDiskCleanup,
  SERVER_DISK_CLEANUP_LOCK_TTL_SECONDS,
} from './server-disk-cleanup-lock';

/** Enough of Redis for the lock: SET NX EX, GET and the compare-and-delete script. */
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
    eval: async (script: string, numKeys: number, key: string, token: string) => {
      expect(script).toContain('redis.call("get", KEYS[1]) == ARGV[1]');
      expect(numKeys).toBe(1);
      if (values.get(key) !== token) return 0;
      values.delete(key);
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

describe('server disk cleanup lock', () => {
  it('lets one cleanup in per server, with a TTL', async () => {
    expect(await acquireServerDiskCleanupLock(S1, 'a', r.redis)).toBe(true);
    expect(r.ttls.get(serverDiskCleanupLockKey(S1))).toBe(SERVER_DISK_CLEANUP_LOCK_TTL_SECONDS);
    expect(await acquireServerDiskCleanupLock(S1, 'b', r.redis)).toBe(false);
    expect(await acquireServerDiskCleanupLock(S2, 'b', r.redis)).toBe(true);
  });

  it('only the holder releases it', async () => {
    await acquireServerDiskCleanupLock(S1, 'a', r.redis);
    await releaseServerDiskCleanupLock(S1, 'b', r.redis);
    expect(r.values.get(serverDiskCleanupLockKey(S1))).toBe('a');
    await releaseServerDiskCleanupLock(S1, 'a', r.redis);
    expect(await acquireServerDiskCleanupLock(S1, 'b', r.redis)).toBe(true);
  });

  it('runs unguarded without Redis (single worker) and skips on a Redis error', async () => {
    expect(await acquireServerDiskCleanupLock(S1, 'a', null)).toBe(true);
    const broken = { set: async () => { throw new Error('down'); } } as unknown as Redis;
    expect(await acquireServerDiskCleanupLock(S1, 'a', broken)).toBe(false);
  });

  it('waits for the other cleanup to finish, bounded', async () => {
    await acquireServerDiskCleanupLock(S1, 'a', r.redis);
    setTimeout(() => void releaseServerDiskCleanupLock(S1, 'a', r.redis), 20);
    expect(await waitForServerDiskCleanup(S1, { redis: r.redis, intervalMs: 5, timeoutMs: 1000 })).toBe(true);

    await acquireServerDiskCleanupLock(S1, 'b', r.redis);
    expect(await waitForServerDiskCleanup(S1, { redis: r.redis, intervalMs: 5, timeoutMs: 20 })).toBe(false);
  });
});
