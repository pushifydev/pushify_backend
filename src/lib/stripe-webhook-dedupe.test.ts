import { describe, it, expect, vi } from 'vitest';

vi.mock('./redis-client', () => ({
  getOptionalRedis: (): null => null,
}));

import { claimStripeWebhookEvent } from './stripe-webhook-dedupe';

describe('claimStripeWebhookEvent', () => {
  it('returns true when Redis is unavailable', async () => {
    await expect(claimStripeWebhookEvent('evt_test_123')).resolves.toBe(true);
  });

  it('returns true when event id is missing', async () => {
    await expect(claimStripeWebhookEvent(undefined)).resolves.toBe(true);
  });
});
