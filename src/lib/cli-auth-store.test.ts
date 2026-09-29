import { describe, it, expect } from 'vitest';
import { createCliAuthStore, type CliRedis } from './cli-auth-store';

/** A tiny Redis stand-in shared by several "processes" (store instances). */
function fakeRedis(): CliRedis & { raw: Map<string, Record<string, string>> } {
  const raw = new Map<string, Record<string, string>>();
  return {
    raw,
    async hset(key, values) {
      raw.set(key, { ...(raw.get(key) ?? {}), ...values });
      return Object.keys(values).length;
    },
    async hgetall(key) {
      return { ...(raw.get(key) ?? {}) };
    },
    async pexpireat() {
      return 1;
    },
    async del(key) {
      return raw.delete(key) ? 1 : 0;
    },
  };
}

const HASH = 'a'.repeat(64);

describe('CLI auth store on Redis', () => {
  it('a session created and approved on one process is collected on another, once', async () => {
    const redis = fakeRedis();
    const api1 = createCliAuthStore(redis);
    const api2 = createCliAuthStore(redis);

    await api1.create(HASH, Date.now() + 60_000);
    expect(await api2.get(HASH)).toMatchObject({ status: 'pending' });
    await api2.approve(HASH, { userId: 'u1', organizationId: 'o1' });

    const [first, second] = await Promise.all([api1.take(HASH), api2.take(HASH)]);
    expect([first, second].filter(Boolean)).toEqual([{ userId: 'u1', organizationId: 'o1' }]);
    expect(await api1.get(HASH)).toBeNull();
  });

  it('stores who approved encrypted, and never an API key', async () => {
    const redis = fakeRedis();
    const store = createCliAuthStore(redis);
    await store.create(HASH, Date.now() + 60_000);
    await store.approve(HASH, { userId: 'user-123', organizationId: 'org-456' });
    const stored = JSON.stringify([...redis.raw.values()]);
    expect(stored).not.toContain('user-123');
    expect(stored).not.toContain('org-456');
    expect(stored).not.toMatch(/pk_(live|test)_/);
  });

  it('treats an expired session as gone', async () => {
    const store = createCliAuthStore(fakeRedis());
    await store.create(HASH, Date.now() - 1);
    expect(await store.get(HASH)).toBeNull();
  });
});
