import { env } from '../config/env';
import { logger } from '../lib/logger';
import { getOptionalRedis } from '../lib/redis-client';

export async function runStartupChecks(role: typeof env.PROCESS_ROLE): Promise<void> {
  if (env.NODE_ENV === 'production' && !env.REDIS_URL) {
    logger.warn(
      'REDIS_URL is not set in production — rate limits and WebSockets are per-instance only. Set REDIS_URL for horizontal scaling.',
    );
  }

  if (env.REDIS_URL) {
    const redis = getOptionalRedis();
    if (redis) {
      try {
        const pong = await redis.ping();
        logger.info({ pong, role }, 'Redis connection verified');
      } catch (err) {
        logger.error({ err, role }, 'Redis PING failed — check REDIS_URL');
        if (env.NODE_ENV === 'production' && role === 'worker') {
          process.exit(1);
        }
      }
    }
  } else if (env.NODE_ENV === 'production' && role === 'worker') {
    logger.error('PROCESS_ROLE=worker requires REDIS_URL in production (BullMQ queues)');
    process.exit(1);
  }

  if (role === 'api' && env.NODE_ENV === 'production') {
    logger.info('API-only process — background workers should run on a separate PROCESS_ROLE=worker service');
  }
}
