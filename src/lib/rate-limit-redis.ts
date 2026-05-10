import type Redis from 'ioredis';

const FIXED_WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
return {c, ttl}
`;

export interface RedisFixedWindowResult {
  count: number;
  resetAtMs: number;
  allowed: boolean;
}

/**
 * Fixed-window counter with TTL aligned to first request in window (matches in-memory behavior).
 */
export async function redisFixedWindowHit(
  redis: Redis,
  key: string,
  windowMs: number,
  maxRequests: number
): Promise<RedisFixedWindowResult> {
  const raw = (await redis.eval(FIXED_WINDOW_LUA, 1, key, windowMs)) as [number, number];
  const count = Number(raw[0]);
  const ttlMs = Number(raw[1]);
  const resetAtMs = Date.now() + (ttlMs > 0 ? ttlMs : windowMs);
  return {
    count,
    resetAtMs,
    allowed: count <= maxRequests,
  };
}
