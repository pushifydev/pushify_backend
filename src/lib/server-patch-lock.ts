import type Redis from 'ioredis';
import { getOptionalRedis } from './redis-client';

/**
 * One security-update run per server at a time. The API takes the lock when it queues a run (a
 * second request gets 409) and the worker holds it until that run is over; the TTL frees it when a
 * worker dies mid-run. Longer than the slowest run (apt update + dpkg lock wait + install + recheck).
 */
export const SERVER_PATCH_LOCK_TTL_SECONDS = 3600;

type LockRedis = Pick<Redis, 'set' | 'get' | 'expire' | 'eval'>;

export function serverPatchLockKey(serverId: string): string {
  return `pushify:server-patch:${serverId}`;
}

/**
 * Take the lock for `token`, or keep it when `token` already holds it (the worker picking up the
 * run it was queued with). False when another run holds it, or without Redis.
 */
export async function acquireServerPatchLock(
  serverId: string,
  token: string,
  redis: LockRedis | null = getOptionalRedis()
): Promise<boolean> {
  if (!redis) return false;
  const key = serverPatchLockKey(serverId);
  if ((await redis.set(key, token, 'EX', SERVER_PATCH_LOCK_TTL_SECONDS, 'NX')) === 'OK') return true;
  if ((await redis.get(key)) === token) {
    await redis.expire(key, SERVER_PATCH_LOCK_TTL_SECONDS);
    return true;
  }
  return false;
}

/** Release the lock if `token` still holds it. Never throws: the TTL frees it anyway. */
export async function releaseServerPatchLock(
  serverId: string,
  token: string,
  redis: LockRedis | null = getOptionalRedis()
): Promise<void> {
  if (!redis) return;
  try {
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      serverPatchLockKey(serverId),
      token
    );
  } catch {
    /* ignore */
  }
}
