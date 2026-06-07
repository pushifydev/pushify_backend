import { env } from '../config/env';
import { getOptionalRedis } from './redis-client';
import { logger } from './logger';

const SLOT_TTL_SEC = 7200;

let memoryGlobalActive = 0;
const memoryPerServer = new Map<string, number>();

const ACQUIRE_SCRIPT = `
local global = tonumber(redis.call('GET', KEYS[1]) or '0')
if global >= tonumber(ARGV[1]) then return 0 end
local server = tonumber(redis.call('GET', KEYS[2]) or '0')
if server >= tonumber(ARGV[2]) then return 0 end
redis.call('INCR', KEYS[1])
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[1], ARGV[3])
redis.call('EXPIRE', KEYS[2], ARGV[3])
return 1
`;

const RELEASE_SCRIPT = `
local global = tonumber(redis.call('GET', KEYS[1]) or '0')
if global > 0 then redis.call('DECR', KEYS[1]) end
local server = tonumber(redis.call('GET', KEYS[2]) or '0')
if server > 0 then redis.call('DECR', KEYS[2]) end
return 1
`;

function globalKey(): string {
  return 'deploy:slots:global';
}

function serverKey(serverId: string): string {
  return `deploy:slots:server:${serverId}`;
}

export async function tryAcquireDeploySlots(serverId: string): Promise<boolean> {
  const redis = getOptionalRedis();
  if (redis) {
    try {
      const result = await redis.eval(
        ACQUIRE_SCRIPT,
        2,
        globalKey(),
        serverKey(serverId),
        String(env.MAX_CONCURRENT_DEPLOYS_TOTAL),
        String(env.MAX_CONCURRENT_DEPLOYS_PER_SERVER),
        String(SLOT_TTL_SEC),
      );
      return result === 1;
    } catch (err) {
      logger.warn({ err, serverId }, 'Redis deploy slot acquire failed, using in-memory fallback');
    }
  }

  if (memoryGlobalActive >= env.MAX_CONCURRENT_DEPLOYS_TOTAL) {
    return false;
  }
  const serverActive = memoryPerServer.get(serverId) || 0;
  if (serverActive >= env.MAX_CONCURRENT_DEPLOYS_PER_SERVER) {
    return false;
  }
  memoryGlobalActive++;
  memoryPerServer.set(serverId, serverActive + 1);
  return true;
}

export async function releaseDeploySlots(serverId: string): Promise<void> {
  const redis = getOptionalRedis();
  if (redis) {
    try {
      await redis.eval(RELEASE_SCRIPT, 2, globalKey(), serverKey(serverId));
      return;
    } catch (err) {
      logger.warn({ err, serverId }, 'Redis deploy slot release failed, using in-memory fallback');
    }
  }

  memoryGlobalActive = Math.max(0, memoryGlobalActive - 1);
  const serverActive = memoryPerServer.get(serverId) || 0;
  memoryPerServer.set(serverId, Math.max(0, serverActive - 1));
}

export function getMemoryActiveDeploymentCount(): number {
  return memoryGlobalActive;
}

/** Check slot availability without acquiring (for poll-mode job selection). */
export async function getGlobalDeployActiveCount(): Promise<number> {
  const redis = getOptionalRedis();
  if (redis) {
    try {
      return parseInt((await redis.get(globalKey())) || '0', 10);
    } catch (err) {
      logger.warn({ err }, 'Redis global deploy slot read failed, using in-memory fallback');
    }
  }

  return memoryGlobalActive;
}

/** Active deploy count on a server (Redis or in-memory). */
export async function getServerDeployActiveCount(serverId: string): Promise<number> {
  const redis = getOptionalRedis();
  if (redis) {
    try {
      return parseInt((await redis.get(serverKey(serverId))) || '0', 10);
    } catch {
      /* fallback */
    }
  }
  return memoryPerServer.get(serverId) || 0;
}

export async function hasDeploySlotAvailable(serverId: string): Promise<boolean> {
  const redis = getOptionalRedis();
  if (redis) {
    try {
      const [globalRaw, serverRaw] = await redis.mget(globalKey(), serverKey(serverId));
      const global = parseInt(globalRaw || '0', 10);
      const server = parseInt(serverRaw || '0', 10);
      return (
        global < env.MAX_CONCURRENT_DEPLOYS_TOTAL &&
        server < env.MAX_CONCURRENT_DEPLOYS_PER_SERVER
      );
    } catch (err) {
      logger.warn({ err, serverId }, 'Redis deploy slot check failed, using in-memory fallback');
    }
  }

  if (memoryGlobalActive >= env.MAX_CONCURRENT_DEPLOYS_TOTAL) {
    return false;
  }
  return (memoryPerServer.get(serverId) || 0) < env.MAX_CONCURRENT_DEPLOYS_PER_SERVER;
}
