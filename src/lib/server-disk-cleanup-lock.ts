import type Redis from 'ioredis';
import { getOptionalRedis } from './redis-client';
import { logger } from './logger';

/**
 * One disk cleanup per server at a time: the hourly scheduled cleanup and the one a deploy runs
 * when the disk guard trips must not prune the same host concurrently (two deploys queued on a
 * full server would otherwise both prune and both measure a half-done cleanup). The TTL frees the
 * lock when a worker dies mid-cleanup; it is longer than the slowest prune of a large build cache.
 *
 * Without Redis there is a single worker process (see deploy-worker-lock.ts), so the cleanup runs
 * unguarded. A Redis error skips the cleanup instead: safer than two prunes at once.
 */
export const SERVER_DISK_CLEANUP_LOCK_TTL_SECONDS = 900;

type LockRedis = Pick<Redis, 'set' | 'get' | 'eval'>;

export function serverDiskCleanupLockKey(serverId: string): string {
  return `pushify:server-disk-cleanup:${serverId}`;
}

/** Take the lock for `token`. False when another cleanup holds it or Redis failed. */
export async function acquireServerDiskCleanupLock(
  serverId: string,
  token: string,
  redis: LockRedis | null = getOptionalRedis()
): Promise<boolean> {
  if (!redis) return true;
  try {
    const set = await redis.set(serverDiskCleanupLockKey(serverId), token, 'EX', SERVER_DISK_CLEANUP_LOCK_TTL_SECONDS, 'NX');
    return set === 'OK';
  } catch (err) {
    logger.warn({ err, serverId }, 'Server disk cleanup lock failed; skipping cleanup');
    return false;
  }
}

/** Release the lock if `token` still holds it. Never throws: the TTL frees it anyway. */
export async function releaseServerDiskCleanupLock(
  serverId: string,
  token: string,
  redis: LockRedis | null = getOptionalRedis()
): Promise<void> {
  if (!redis) return;
  try {
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      serverDiskCleanupLockKey(serverId),
      token
    );
  } catch {
    /* ignore */
  }
}

/**
 * Wait (bounded) for another cleanup on the server to finish, so a deploy that found the lock
 * taken can measure the disk once that cleanup is done instead of failing on a half-done one.
 * True when the lock is free, false on timeout or a Redis error.
 */
export async function waitForServerDiskCleanup(
  serverId: string,
  opts: { timeoutMs?: number; intervalMs?: number; redis?: LockRedis | null } = {}
): Promise<boolean> {
  const { timeoutMs = 120_000, intervalMs = 3_000 } = opts;
  const redis = opts.redis === undefined ? getOptionalRedis() : opts.redis;
  if (!redis) return true;
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if ((await redis.get(serverDiskCleanupLockKey(serverId))) === null) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  } catch {
    return false;
  }
}
