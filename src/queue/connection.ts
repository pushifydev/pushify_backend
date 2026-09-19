import { Redis } from 'ioredis';
import { env } from '../config/env';

// Create Redis connection for BullMQ. Reads the validated env — the old `process.env` read
// fell back to redis://localhost:6379 when REDIS_URL was unset, so the server-status and
// server-setup workers retried a Redis that was never there instead of staying off like
// every other queue does.
export const createRedisConnection = () => {
  if (!env.REDIS_URL) {
    throw new Error('REDIS_URL is not configured — BullMQ workers stay off');
  }
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null, // Required by BullMQ
    enableReadyCheck: false,
  });
};

// Shared connection for queues
let sharedConnection: Redis | null = null;

export const getRedisConnection = (): Redis => {
  if (!sharedConnection) {
    sharedConnection = createRedisConnection();
  }
  return sharedConnection;
};

// Close connection gracefully
export const closeRedisConnection = async (): Promise<void> => {
  if (sharedConnection) {
    await sharedConnection.quit();
    sharedConnection = null;
  }
};
