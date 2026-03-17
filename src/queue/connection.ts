import { Redis } from 'ioredis';

// Redis connection configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

// Create Redis connection for BullMQ
export const createRedisConnection = () => {
  return new Redis(REDIS_URL, {
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
