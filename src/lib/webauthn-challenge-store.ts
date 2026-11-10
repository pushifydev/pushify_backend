import { getOptionalRedis } from './redis-client';

/**
 * Challenges handed out by the passkey `options` routes, until the matching `verify` uses them.
 * In Redis (shared by every API process, expiring on their own), or in process memory when Redis
 * is not configured, as the CLI login store does. Single use: `take` removes the challenge, so an
 * answer to it — even a correctly signed one — is accepted at most once.
 *
 * Keyed by the challenge itself: the browser signs it into clientDataJSON, so the verify route can
 * find its ceremony without a second token. The value is who the challenge was issued to (the user
 * for a registration, a fixed marker for a sign-in, where nobody is known yet).
 */

export type WebAuthnCeremony = 'registration' | 'authentication';

/** The subset of ioredis used here, so tests can pass a fake. */
export interface ChallengeRedis {
  set(key: string, value: string, mode: 'PX', ttlMs: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

const PREFIX = 'webauthn:challenge:';
const MAX_MEMORY_ENTRIES = 10_000;

export function createWebAuthnChallengeStore(redis: ChallengeRedis | null) {
  const memory = new Map<string, { subject: string; expiresAt: number }>();
  const sweepMemory = () => {
    const now = Date.now();
    for (const [k, v] of memory) if (v.expiresAt < now) memory.delete(k);
    // The sign-in options route is public: never let it grow without bound (oldest first)
    while (memory.size >= MAX_MEMORY_ENTRIES) {
      const oldest = memory.keys().next().value;
      if (oldest === undefined) break;
      memory.delete(oldest);
    }
  };
  const keyOf = (ceremony: WebAuthnCeremony, challenge: string) => `${PREFIX}${ceremony}:${challenge}`;

  return {
    async save(ceremony: WebAuthnCeremony, challenge: string, subject: string, ttlMs: number): Promise<void> {
      if (redis) {
        await redis.set(keyOf(ceremony, challenge), subject, 'PX', ttlMs);
        return;
      }
      sweepMemory();
      memory.set(keyOf(ceremony, challenge), { subject, expiresAt: Date.now() + ttlMs });
    },

    /** Who the challenge was issued to, removed as it is read; null when unknown, used or expired. */
    async take(ceremony: WebAuthnCeremony, challenge: string): Promise<string | null> {
      const key = keyOf(ceremony, challenge);
      if (redis) {
        const subject = await redis.get(key);
        if (subject === null) return null;
        // Only the caller whose delete succeeded gets it: two processes cannot both use it
        if ((await redis.del(key)) !== 1) return null;
        return subject;
      }
      const row = memory.get(key);
      if (!row) return null;
      memory.delete(key);
      return row.expiresAt < Date.now() ? null : row.subject;
    },
  };
}

export type WebAuthnChallengeStore = ReturnType<typeof createWebAuthnChallengeStore>;

let shared: WebAuthnChallengeStore | null = null;
export function webauthnChallengeStore(): WebAuthnChallengeStore {
  if (!shared) shared = createWebAuthnChallengeStore(getOptionalRedis());
  return shared;
}
