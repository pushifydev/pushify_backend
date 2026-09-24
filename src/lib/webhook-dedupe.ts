import { getOptionalRedis } from './redis-client';
import { logger } from './logger';

const PREFIX = 'pushify:github-wh:delivery:';
const TTL_SEC = 172800; // 48h — GitHub may retry deliveries

/**
 * Returns true if this delivery should be processed (first time), false if duplicate.
 * Without Redis, always returns true (single-instance dedupe only via logs).
 */
export async function claimGitHubWebhookDelivery(deliveryId: string | undefined): Promise<boolean> {
  if (!deliveryId) {
    return true;
  }

  const redis = getOptionalRedis();
  if (!redis) {
    return true;
  }

  try {
    const key = `${PREFIX}${deliveryId}`;
    const ok = await redis.set(key, '1', 'EX', TTL_SEC, 'NX');
    if (ok !== 'OK') {
      logger.info({ deliveryId }, 'Skipping duplicate GitHub webhook delivery');
      return false;
    }
    return true;
  } catch (err) {
    // Redis is configured but unreachable. Fail CLOSED: rethrow so the webhook returns a
    // non-2xx and GitHub retries the delivery instead of us processing it with no dedupe
    // (which could create duplicate deployments). (No Redis configured → return true above.) — H-6
    logger.error({ err, deliveryId }, 'Webhook dedupe store unavailable; deferring for retry');
    throw err;
  }
}

/**
 * Drops a claim made by {@link claimGitHubWebhookDelivery} so a retry (GitHub/GitLab automatic
 * redelivery or a manual "Redeliver") of the same delivery id is processed again. Used when
 * processing fails after the claim. Never throws: a failed release is logged, the original
 * processing error is what matters to the caller.
 */
export async function releaseGitHubWebhookDelivery(deliveryId: string | undefined): Promise<void> {
  if (!deliveryId) {
    return;
  }

  const redis = getOptionalRedis();
  if (!redis) {
    return;
  }

  try {
    await redis.del(`${PREFIX}${deliveryId}`);
  } catch (err) {
    logger.error({ err, deliveryId }, 'Failed to release webhook delivery claim; retries may be ignored');
  }
}

/**
 * Runs the work for an already-claimed delivery. If it throws, the claim is released before the
 * error is rethrown, so the non-2xx response leads to a retry that is actually processed instead
 * of being skipped as a duplicate.
 */
export async function processClaimedWebhookDelivery<T>(
  deliveryId: string | undefined,
  work: () => Promise<T>
): Promise<T> {
  try {
    return await work();
  } catch (err) {
    await releaseGitHubWebhookDelivery(deliveryId);
    throw err;
  }
}
