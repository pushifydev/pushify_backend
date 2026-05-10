import { describe, it, expect, vi } from 'vitest';

vi.mock('./redis-client', () => ({
  getOptionalRedis: (): null => null,
}));

import { claimGitHubWebhookDelivery } from './webhook-dedupe';

describe('claimGitHubWebhookDelivery', () => {
  it('returns true when Redis is unavailable', async () => {
    await expect(claimGitHubWebhookDelivery('550e8400-e29b-41d4-a716-446655440000')).resolves.toBe(true);
  });

  it('returns true when delivery id is missing', async () => {
    await expect(claimGitHubWebhookDelivery(undefined)).resolves.toBe(true);
  });
});
