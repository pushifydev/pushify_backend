import { randomUUID } from 'crypto';
import { getOptionalRedis } from './redis-client';
import { logger } from './logger';

const LOCK_KEY = 'pushify:deploy-worker:leader';
const LOCK_TTL_SEC = 20;

const holderId = randomUUID();

/**
 * When REDIS_URL is set, only one worker instance polls deployments at a time.
 * Without Redis, every worker process polls (use a single worker replica).
 */
export async function tryHoldDeployWorkerLeadership(): Promise<boolean> {
  const redis = getOptionalRedis();
  if (!redis) {
    return true;
  }

  try {
    const acquired = await redis.set(LOCK_KEY, holderId, 'EX', LOCK_TTL_SEC, 'NX');
    if (acquired === 'OK') {
      return true;
    }

    const current = await redis.get(LOCK_KEY);
    if (current === holderId) {
      await redis.expire(LOCK_KEY, LOCK_TTL_SEC);
      return true;
    }

    return false;
  } catch (err) {
    logger.warn({ err }, 'Deploy worker leader lock failed; skipping poll cycle');
    return false;
  }
}

export async function releaseDeployWorkerLeadership(): Promise<void> {
  const redis = getOptionalRedis();
  if (!redis) return;

  try {
    await redis.eval(
      `if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end`,
      1,
      LOCK_KEY,
      holderId,
    );
  } catch {
    /* ignore */
  }
}
