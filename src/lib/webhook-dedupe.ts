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
    logger.warn({ err, deliveryId }, 'Webhook dedupe Redis failed; processing delivery anyway');
    return true;
  }
}
