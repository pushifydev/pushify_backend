import crypto from 'crypto';
import { getOptionalRedis } from './redis-client';
import { logger } from './logger';

export type OAuthStateKind =
  | 'github_app_install'
  | 'github_integration'
  | 'gitlab_integration'
  | 'github_login'
  | 'google_login';

/** Which client started the flow — decides where the callback hands the session back to. */
export type OAuthPlatform = 'web' | 'mobile';

/** Deep link the released mobile app listens on. */
export const MOBILE_APP_REDIRECT = 'pushify://auth-callback';

/**
 * Expo Go can't register the app's own scheme, so during development the app is
 * reached at exp://<host>:<port>/--/auth-callback instead. Handing a session to an
 * arbitrary exp:// host would be an account-takeover vector — anyone could start a
 * flow pointed at a host they control — so these are only honored when explicitly
 * enabled, and never by default.
 */
const EXPO_DEV_REDIRECT = /^exp(\+[a-z0-9-]+)?:\/\/[^\s/]+\/--\/auth-callback$/i;

function devRedirectsAllowed(): boolean {
  return process.env.ALLOW_EXPO_DEV_REDIRECTS === 'true' || process.env.NODE_ENV !== 'production';
}

/**
 * Resolve where a mobile OAuth session may be handed back to. Returns null for
 * anything not explicitly allowed, so callers can reject the request outright
 * rather than redirecting somewhere unvetted.
 */
export function resolveMobileRedirect(requested?: string): string | null {
  if (!requested) return MOBILE_APP_REDIRECT;
  if (requested === MOBILE_APP_REDIRECT) return requested;
  if (devRedirectsAllowed() && EXPO_DEV_REDIRECT.test(requested)) return requested;
  return null;
}

export interface OAuthStateRecord {
  kind: OAuthStateKind;
  /** Required for github_integration (authenticated connect flow) */
  userId?: string;
  /** Defaults to web when absent (every pre-existing state record). */
  platform?: OAuthPlatform;
  /** Already validated when the state was created; the callback only echoes it. */
  appRedirect?: string;
  /** Which organisation a github_app_install belongs to, captured before leaving for GitHub. */
  organizationId?: string;
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
