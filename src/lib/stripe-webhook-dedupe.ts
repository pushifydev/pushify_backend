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
    // Redis is configured but unreachable. Fail CLOSED: rethrow so the webhook returns a
    // non-2xx and Stripe retries later (it retries for days) instead of processing the event
    // with no dedupe. (When Redis is simply not configured we return true above.) — H-6
    logger.error({ err, eventId }, 'Stripe webhook dedupe store unavailable; deferring for retry');
    throw err;
  }
}
