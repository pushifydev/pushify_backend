import { getOptionalRedis } from './redis-client';

export async function getCachedJson<T>(
  key: string,
  ttlSec: number,
  fetcher: () => Promise<T>,
): Promise<T> {
  if (ttlSec <= 0) {
    return fetcher();
  }

  const redis = getOptionalRedis();
  if (!redis) {
    return fetcher();
  }

  try {
    const cached = await redis.get(key);
    if (cached) {
      return JSON.parse(cached) as T;
    }
  } catch {
    /* miss — recompute */
  }

  const value = await fetcher();
  try {
    await redis.setex(key, ttlSec, JSON.stringify(value));
  } catch {
    /* ignore cache write errors */
  }

  return value;
}

export async function invalidateCachedKeys(...keys: string[]): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis || keys.length === 0) {
    return;
  }
  try {
    await redis.del(...keys);
  } catch {
    /* ignore */
  }
}
