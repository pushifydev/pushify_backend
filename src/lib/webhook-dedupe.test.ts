import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-in for the ioredis calls used by webhook-dedupe (SET ... NX, DEL).
const store = new Map<string, string>();
const fakeRedis = {
  set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number, _nx: string) => {
    if (store.has(key)) return null;
    store.set(key, value);
    return 'OK';
  }),
  del: vi.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
};
let redisEnabled = false;

vi.mock('./redis-client', () => ({
  getOptionalRedis: () => (redisEnabled ? fakeRedis : null),
}));

import {
  claimGitHubWebhookDelivery,
  processClaimedWebhookDelivery,
  releaseGitHubWebhookDelivery,
} from './webhook-dedupe';

const DELIVERY = '550e8400-e29b-41d4-a716-446655440000';

describe('claimGitHubWebhookDelivery', () => {
  beforeEach(() => {
    redisEnabled = false;
    store.clear();
    vi.clearAllMocks();
  });

  it('returns true when Redis is unavailable', async () => {
    await expect(claimGitHubWebhookDelivery(DELIVERY)).resolves.toBe(true);
  });

  it('returns true when delivery id is missing', async () => {
    await expect(claimGitHubWebhookDelivery(undefined)).resolves.toBe(true);
  });

  it('skips a second claim of the same delivery id', async () => {
    redisEnabled = true;
    await expect(claimGitHubWebhookDelivery(DELIVERY)).resolves.toBe(true);
    await expect(claimGitHubWebhookDelivery(DELIVERY)).resolves.toBe(false);
  });
});

describe('processClaimedWebhookDelivery', () => {
  beforeEach(() => {
    redisEnabled = true;
    store.clear();
    vi.clearAllMocks();
  });

  it('releases the claim when processing fails so the redelivery is processed', async () => {
    const handlePushEvent = vi
      .fn<() => Promise<{ message: string }>>()
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValueOnce({ message: 'Deployment triggered' });

    const deliver = async () => {
      if (!(await claimGitHubWebhookDelivery(DELIVERY))) return { message: 'Duplicate webhook delivery ignored' };
      return processClaimedWebhookDelivery(DELIVERY, () => handlePushEvent());
    };

    await expect(deliver()).rejects.toThrow('queue unavailable');
    expect(fakeRedis.del).toHaveBeenCalledTimes(1);

    await expect(deliver()).resolves.toEqual({ message: 'Deployment triggered' });
    expect(handlePushEvent).toHaveBeenCalledTimes(2);

    // After a successful run the claim stays, so a further redelivery is a duplicate.
    await expect(deliver()).resolves.toEqual({ message: 'Duplicate webhook delivery ignored' });
    expect(handlePushEvent).toHaveBeenCalledTimes(2);
  });

  it('keeps the claim when processing succeeds', async () => {
    await claimGitHubWebhookDelivery(DELIVERY);
    await expect(processClaimedWebhookDelivery(DELIVERY, async () => 'ok')).resolves.toBe('ok');
    expect(fakeRedis.del).not.toHaveBeenCalled();
    await expect(claimGitHubWebhookDelivery(DELIVERY)).resolves.toBe(false);
  });

  it('does not release when there is no delivery id', async () => {
    await expect(
      processClaimedWebhookDelivery(undefined, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(fakeRedis.del).not.toHaveBeenCalled();
  });

  it('rethrows the original error even if releasing the claim fails', async () => {
    fakeRedis.del.mockRejectedValueOnce(new Error('redis down'));
    await claimGitHubWebhookDelivery(DELIVERY);
    await expect(
      processClaimedWebhookDelivery(DELIVERY, async () => {
        throw new Error('db error');
      })
    ).rejects.toThrow('db error');
  });
});

describe('releaseGitHubWebhookDelivery', () => {
  it('is a no-op without Redis', async () => {
    redisEnabled = false;
    vi.clearAllMocks();
    await expect(releaseGitHubWebhookDelivery(DELIVERY)).resolves.toBeUndefined();
    expect(fakeRedis.del).not.toHaveBeenCalled();
  });
});
