import Redis from 'ioredis';
import { env } from '../config/env';
import { logger } from './logger';

let optionalClient: Redis | null = null;

/** Shared Redis connection when REDIS_URL is set (rate limits, webhook dedupe). BullMQ uses its own connection config. */
export function getOptionalRedis(): Redis | null {
  if (!env.REDIS_URL) {
    return null;
  }
  if (!optionalClient) {
    optionalClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
    });
    optionalClient.on('error', (err) => logger.error({ err }, 'Optional Redis client error'));
  }
  return optionalClient;
}

export async function closeOptionalRedis(): Promise<void> {
  if (optionalClient) {
    await optionalClient.quit().catch(() => {});
    optionalClient = null;
  }
}
