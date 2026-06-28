import { env } from '../config/env';

/**
 * Parse REDIS_URL into a BullMQ connection object, honoring the DB index in the URL path
 * (e.g. `redis://host:6379/1` → db 1).
 *
 * Without the db, every environment sharing one Redis host lands on db 0 and the static queue
 * names (`deployments`, `notifications`, …) collide — so a *staging* worker can pick up and run
 * a *production* deployment job (and vice-versa). Two symptoms of that bug: deploys intermittently
 * running on the wrong host, and runner routing silently lost (the staging env lacks
 * PUSHIFY_RUNNER_SERVER_IDS, so it falls back to a local deploy). Honoring the db index lets each
 * environment isolate its queues by pointing REDIS_URL at a different db, e.g. staging on `/1`.
 */
export function getBullRedisConnection() {
  if (!env.REDIS_URL) return null;
  const url = new URL(env.REDIS_URL);
  const dbStr = url.pathname.replace(/^\//, '');
  const db = dbStr ? parseInt(dbStr, 10) : 0;
  return {
    host: url.hostname,
    port: parseInt(url.port, 10) || 6379,
    password: url.password || undefined,
    username: url.username || undefined,
    db: Number.isNaN(db) ? 0 : db,
  };
}
