import { getOptionalRedis } from './redis-client';
import { logger } from './logger';

const PREFIX = 'pushify:stripe-wh:event:';
/** Stripe may retry deliveries for up to several days */
const TTL_SEC = 7 * 24 * 60 * 60;

/**
 * Returns true if this event should be processed (first delivery), false if duplicate.
 */
export async function claimStripeWebhookEvent(eventId: string | undefined): Promise<boolean> {
  if (!eventId) {
    return true;
  }

  const redis = getOptionalRedis();
  if (!redis) {
    return true;
  }

  try {
    const key = `${PREFIX}${eventId}`;
    const ok = await redis.set(key, '1', 'EX', TTL_SEC, 'NX');
    if (ok !== 'OK') {
      logger.info({ eventId }, 'Skipping duplicate Stripe webhook event');
      return false;
    }
    return true;
  } catch (err) {
    logger.warn({ err, eventId }, 'Stripe webhook dedupe Redis failed; processing event anyway');
    return true;
  }
}
