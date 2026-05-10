import { describe, it, expect, vi } from 'vitest';
import { redisFixedWindowHit } from './rate-limit-redis';

describe('redisFixedWindowHit', () => {
  it('allows requests under the limit', async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([3, 45000]),
    };
    const r = await redisFixedWindowHit(redis as never, 'k', 60_000, 100);
    expect(r.count).toBe(3);
    expect(r.allowed).toBe(true);
    expect(r.resetAtMs).toBeGreaterThan(Date.now());
  });

  it('blocks when count exceeds max', async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([101, 1000]),
    };
    const r = await redisFixedWindowHit(redis as never, 'k', 60_000, 100);
    expect(r.allowed).toBe(false);
  });
});
