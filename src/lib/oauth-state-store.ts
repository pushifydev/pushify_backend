import crypto from 'crypto';
import { getOptionalRedis } from './redis-client';
import { logger } from './logger';

export type OAuthStateKind =
  | 'github_integration'
  | 'gitlab_integration'
  | 'github_login'
  | 'google_login';

export interface OAuthStateRecord {
  kind: OAuthStateKind;
  /** Required for github_integration (authenticated connect flow) */
  userId?: string;
}

const PREFIX = 'pushify:oauth:state:';
const TTL_SEC = 600;

type MemoryEntry = { record: OAuthStateRecord; expiresAt: number };
const memoryStates = new Map<string, MemoryEntry>();

function pruneMemoryStates(): void {
  const now = Date.now();
  for (const [key, entry] of memoryStates) {
    if (entry.expiresAt <= now) {
      memoryStates.delete(key);
    }
  }
}

/**
 * Create a cryptographically random OAuth state and store it (Redis or in-memory fallback).
 */
export async function createOAuthState(record: OAuthStateRecord): Promise<string> {
  const state = crypto.randomBytes(32).toString('hex');
  const payload = JSON.stringify(record);

  const redis = getOptionalRedis();
  if (redis) {
    try {
      await redis.set(`${PREFIX}${state}`, payload, 'EX', TTL_SEC);
      return state;
    } catch (err) {
      logger.warn({ err, kind: record.kind }, 'OAuth state Redis set failed; using memory fallback');
    }
  }

  pruneMemoryStates();
  memoryStates.set(state, { record, expiresAt: Date.now() + TTL_SEC * 1000 });
  return state;
}

/**
 * Validate and consume a one-time OAuth state. Returns null if missing, expired, or invalid JSON.
 */
export async function consumeOAuthState(state: string): Promise<OAuthStateRecord | null> {
  if (!state || state.length < 16) {
    return null;
  }

  const redis = getOptionalRedis();
  if (redis) {
    try {
      const key = `${PREFIX}${state}`;
      const raw =
        typeof redis.getdel === 'function'
          ? await redis.getdel(key)
          : await redis.get(key).then(async (v) => {
              if (v) await redis.del(key);
              return v;
            });

      if (!raw) return null;
      return JSON.parse(raw) as OAuthStateRecord;
    } catch (err) {
      logger.warn({ err }, 'OAuth state Redis consume failed');
      return null;
    }
  }

  const entry = memoryStates.get(state);
  memoryStates.delete(state);
  if (!entry || entry.expiresAt <= Date.now()) {
    return null;
  }
  return entry.record;
}

export function validateOAuthStateRecord(
  record: OAuthStateRecord | null,
  expected: { kind: OAuthStateKind; userId?: string },
): boolean {
  if (!record || record.kind !== expected.kind) {
    return false;
  }
  if (expected.userId !== undefined && record.userId !== expected.userId) {
    return false;
  }
  return true;
}
