import { pool } from '../db';
import { logger } from './logger';

export type AdvisoryLockRun<T> = { acquired: true; result: T } | { acquired: false };

/**
 * Run `work` while holding the Postgres advisory lock `key`, so a sweep never runs in two worker
 * processes at once (every worker sweeps as soon as it starts, so two that start together would
 * otherwise both do it). When another session holds the lock, `work` is not called.
 *
 * The lock belongs to a session, so it is taken and released on one dedicated connection while
 * the work itself runs through `db`. Through `db` the unlock could land on another pooled
 * connection, fail, and leave the lock held, so later sweeps skipped without a trace.
 */
export async function withAdvisoryLock<T>(key: string, work: () => Promise<T>): Promise<AdvisoryLockRun<T>> {
  const lockClient = await pool.connect();
  let unlockError: Error | undefined;
  try {
    const lock = await lockClient.query<{ ok: boolean }>('select pg_try_advisory_lock(hashtext($1)) as ok', [key]);
    if (lock.rows[0]?.ok !== true) return { acquired: false };
    try {
      return { acquired: true, result: await work() };
    } finally {
      await lockClient.query('select pg_advisory_unlock(hashtext($1))', [key]).catch((err: unknown) => {
        unlockError = err instanceof Error ? err : new Error(String(err));
        logger.warn({ err: unlockError, key }, 'Advisory lock release failed; closing its connection');
      });
    }
  } finally {
    // A connection whose unlock failed is closed instead of returned to the pool, ending the lock.
    lockClient.release(unlockError);
  }
}
