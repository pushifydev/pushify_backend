import { encrypt, decrypt } from './encryption';
import { getOptionalRedis } from './redis-client';
import { logger } from './logger';

/**
 * Where CLI browser-login sessions live between `create-session`, `approve` and `poll`. In Redis
 * (shared by every API process, expiring on their own), or in process memory when Redis is not
 * configured. Keyed by the SHA-256 of the code; who approved is stored encrypted. No API key is
 * ever stored — it is created when the CLI collects it.
 */

export interface CliApproval {
  userId: string;
  organizationId: string;
}

export interface CliSessionState {
  status: 'pending' | 'approved';
  expiresAt: number;
}

/** The subset of ioredis used here, so tests can pass a fake. */
export interface CliRedis {
  hset(key: string, values: Record<string, string>): Promise<number>;
  hgetall(key: string): Promise<Record<string, string>>;
  pexpireat(key: string, at: number): Promise<number>;
  del(key: string): Promise<number>;
}

const PREFIX = 'cli-auth:';

export function createCliAuthStore(redis: CliRedis | null) {
  const memory = new Map<string, { status: 'pending' | 'approved'; expiresAt: number; approval: string | null }>();
  const sweepMemory = () => {
    const now = Date.now();
    for (const [k, v] of memory) if (v.expiresAt < now) memory.delete(k);
  };

  return {
    async create(codeHash: string, expiresAt: number): Promise<void> {
      if (redis) {
        await redis.hset(PREFIX + codeHash, { status: 'pending', expiresAt: String(expiresAt) });
        await redis.pexpireat(PREFIX + codeHash, expiresAt);
        return;
      }
      sweepMemory();
      memory.set(codeHash, { status: 'pending', expiresAt, approval: null });
    },

    async get(codeHash: string): Promise<CliSessionState | null> {
      if (redis) {
        const row = await redis.hgetall(PREFIX + codeHash);
        if (!row.status) return null;
        const expiresAt = Number(row.expiresAt);
        if (expiresAt < Date.now()) return null;
        return { status: row.status === 'approved' ? 'approved' : 'pending', expiresAt };
      }
      const row = memory.get(codeHash);
      if (!row || row.expiresAt < Date.now()) return null;
      return { status: row.status, expiresAt: row.expiresAt };
    },

    async approve(codeHash: string, approval: CliApproval): Promise<void> {
      const sealed = encrypt(JSON.stringify(approval));
      if (redis) {
        await redis.hset(PREFIX + codeHash, { status: 'approved', approval: sealed });
        return;
      }
      const row = memory.get(codeHash);
      if (row) memory.set(codeHash, { ...row, status: 'approved', approval: sealed });
    },

    /**
     * An approved session, removed as it is read: only the caller whose delete succeeded gets
     * it, so concurrent polls on different processes cannot both issue a key.
     */
    async take(codeHash: string): Promise<CliApproval | null> {
      let sealed: string | undefined;
      if (redis) {
        const row = await redis.hgetall(PREFIX + codeHash);
        if (row.status !== 'approved' || !row.approval) return null;
        if ((await redis.del(PREFIX + codeHash)) !== 1) return null;
        sealed = row.approval;
      } else {
        const row = memory.get(codeHash);
        if (!row || row.status !== 'approved' || !row.approval) return null;
        memory.delete(codeHash);
        sealed = row.approval;
      }
      try {
        return JSON.parse(decrypt(sealed)) as CliApproval;
      } catch (err) {
        logger.warn({ err }, 'CLI auth: could not read an approval');
        return null;
      }
    },

    async remove(codeHash: string): Promise<void> {
      if (redis) await redis.del(PREFIX + codeHash);
      else memory.delete(codeHash);
    },
  };
}

export type CliAuthStore = ReturnType<typeof createCliAuthStore>;

let shared: CliAuthStore | null = null;
export function cliAuthStore(): CliAuthStore {
  if (!shared) shared = createCliAuthStore(getOptionalRedis());
  return shared;
}
