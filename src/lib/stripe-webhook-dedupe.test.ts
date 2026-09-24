import { describe, it, expect, vi, beforeEach } from 'vitest';

type FakeRedis = {
  set: (key: string, value: string, ...args: unknown[]) => Promise<'OK' | null>;
  del: (key: string) => Promise<number>;
};

const state = vi.hoisted(() => ({ redis: null as FakeRedis | null }));

vi.mock('./redis-client', () => ({
  getOptionalRedis: () => state.redis,
}));

import { claimStripeWebhookEvent, releaseStripeWebhookEvent } from './stripe-webhook-dedupe';

function createFakeRedis(): FakeRedis {
  const store = new Map<string, string>();
  return {
    set: vi.fn(async (key: string, value: string, ...args: unknown[]) => {
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK' as const;
    }),
    del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  };
}

/** Mirrors the claim → process → release-on-failure flow in stripeService.handleWebhookEvent. */
async function deliver(eventId: string, process: () => Promise<void>): Promise<'processed' | 'skipped'> {
  if (!(await claimStripeWebhookEvent(eventId))) return 'skipped';
  try {
    await process();
  } catch (err) {
    await releaseStripeWebhookEvent(eventId);
    throw err;
  }
  return 'processed';
}

describe('claimStripeWebhookEvent without Redis', () => {
  beforeEach(() => {
    state.redis = null;
  });

  it('returns true when Redis is unavailable', async () => {
    await expect(claimStripeWebhookEvent('evt_test_123')).resolves.toBe(true);
  });

  it('returns true when event id is missing', async () => {
    await expect(claimStripeWebhookEvent(undefined)).resolves.toBe(true);
  });

  it('release is a no-op when Redis is unavailable', async () => {
    await expect(releaseStripeWebhookEvent('evt_test_123')).resolves.toBeUndefined();
  });
});

describe('Stripe webhook dedupe with Redis', () => {
  beforeEach(() => {
    state.redis = createFakeRedis();
  });

  it('skips a duplicate delivery after successful processing', async () => {
    const process = vi.fn(async () => {});
    await expect(deliver('evt_ok', process)).resolves.toBe('processed');
    await expect(deliver('evt_ok', process)).resolves.toBe('skipped');
    expect(process).toHaveBeenCalledTimes(1);
  });

  it('re-processes a retry when the first processing attempt fails', async () => {
    const process = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);

    await expect(deliver('evt_fail', process)).rejects.toThrow('db down');
    await expect(deliver('evt_fail', process)).resolves.toBe('processed');
    expect(process).toHaveBeenCalledTimes(2);

    // Now that it succeeded, further retries are deduplicated.
    await expect(deliver('evt_fail', process)).resolves.toBe('skipped');
    expect(process).toHaveBeenCalledTimes(2);
  });

  it('release does not throw when Redis del fails', async () => {
    state.redis!.del = vi.fn(async () => {
      throw new Error('redis down');
    });
    await expect(releaseStripeWebhookEvent('evt_x')).resolves.toBeUndefined();
  });
});
