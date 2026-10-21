import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The sweep's advisory lock is per session, so it must be taken and released on one connection
 * that goes back to the pool afterwards, whatever happens in between. The purge itself is covered
 * against a real Postgres in deletion-purge.db.test.ts.
 */
const h = vi.hoisted(() => ({
  lockOk: true,
  unlockFails: false,
  selectFails: false,
  queries: [] as Array<{ client: number; text: string }>,
  released: [] as Array<{ client: number; err: unknown }>,
  connects: 0,
}));

vi.mock('../db', () => ({
  pool: {
    connect: async () => {
      const client = ++h.connects;
      return {
        query: async (text: string) => {
          h.queries.push({ client, text });
          if (text.includes('pg_try_advisory_lock')) return { rows: [{ ok: h.lockOk }] };
          if (h.unlockFails) throw new Error('connection terminated');
          return { rows: [{ pg_advisory_unlock: true }] };
        },
        release: (err?: unknown) => {
          h.released.push({ client, err });
        },
      };
    },
  },
  db: {
    select: () => ({
      from: () => ({
        where: async () => {
          if (h.selectFails) throw new Error('db down');
          return [];
        },
      }),
    }),
  },
}));

import { logger } from '../lib/logger';
import { deletionPurgeService } from './deletion-purge.service';

const NOW = new Date('2026-11-01T00:00:00Z');

beforeEach(() => {
  h.lockOk = true;
  h.unlockFails = false;
  h.selectFails = false;
  h.queries = [];
  h.released = [];
  h.connects = 0;
  vi.restoreAllMocks();
});

describe('deletionPurgeService.sweep lock', () => {
  it('takes and releases the lock on the same connection, then returns it to the pool', async () => {
    expect(await deletionPurgeService.sweep(NOW)).toEqual({ reminded: 0, organizations: 0, accounts: 0, pending: 0 });
    expect(h.connects).toBe(1);
    expect(h.queries.map((q) => q.client)).toEqual([1, 1]);
    expect(h.queries[0].text).toContain('pg_try_advisory_lock');
    expect(h.queries[1].text).toContain('pg_advisory_unlock');
    expect(h.released).toEqual([{ client: 1, err: undefined }]);
  });

  it('logs and returns zeros when another sweep holds the lock', async () => {
    h.lockOk = false;
    const info = vi.spyOn(logger, 'info');
    expect(await deletionPurgeService.sweep(NOW)).toEqual({ reminded: 0, organizations: 0, accounts: 0, pending: 0 });
    expect(info).toHaveBeenCalledWith(expect.stringContaining('another sweep holds the lock'));
    expect(h.queries.map((q) => q.text).some((t) => t.includes('pg_advisory_unlock'))).toBe(false);
    expect(h.released).toEqual([{ client: 1, err: undefined }]);
  });

  it('releases the lock when the sweep fails', async () => {
    h.selectFails = true;
    await expect(deletionPurgeService.sweep(NOW)).rejects.toThrow('db down');
    expect(h.queries.map((q) => q.client)).toEqual([1, 1]);
    expect(h.queries[1].text).toContain('pg_advisory_unlock');
    expect(h.released).toEqual([{ client: 1, err: undefined }]);
  });

  it('closes the connection instead of reusing it when the unlock fails', async () => {
    h.unlockFails = true;
    const warn = vi.spyOn(logger, 'warn');
    expect(await deletionPurgeService.sweep(NOW)).toMatchObject({ organizations: 0 });
    expect(warn).toHaveBeenCalled();
    expect(h.released).toHaveLength(1);
    expect(h.released[0].err).toBeInstanceOf(Error);
  });
});
