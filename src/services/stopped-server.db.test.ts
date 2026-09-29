import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * Managed servers left off for non-payment, against a real Postgres
 * (ACCOUNT_DELETION_TEST_DATABASE_URL). Hetzner and email are fakes.
 */
const TEST_URL = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ destroy: vi.fn(), warn: vi.fn(), deleted: vi.fn(), admin: vi.fn() }));

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.ACCOUNT_DELETION_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 4 });
  return { db: drizzle(pool, { schema }), __pool: pool };
});
vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return { env: { ...actual.env, HETZNER_API_TOKEN: 'hz_test' } };
});
vi.mock('../providers', () => ({ createProvider: () => ({}) }));
vi.mock('./server.service', () => ({ destroyAtProvider: h.destroy }));
vi.mock('../lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email')>();
  return { ...actual, sendStoppedServerWarningEmail: h.warn, sendStoppedServerDeletedEmail: h.deleted };
});
vi.mock('../lib/billing-notify', () => ({ resolveBillingNotifyEmail: async () => 'owner@example.com' }));
vi.mock('./admin-notify.service', () => ({ adminNotify: h.admin }));

import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { organizations, servers } from '../db/schema';
import { stoppedServerAction, stoppedServerService } from './stopped-server.service';

const NOW = new Date('2026-11-01T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
let seq = 0;

async function makeOrg(over: Partial<typeof organizations.$inferInsert> = {}) {
  seq++;
  const [o] = await db.insert(organizations).values({ name: `stopped-test-${seq}`, slug: `stopped-test-${Date.now()}-${seq}`, ...over }).returning();
  return o;
}
async function makeServer(orgId: string, over: Partial<typeof servers.$inferInsert>) {
  const [s] = await db
    .insert(servers)
    .values({ organizationId: orgId, name: `srv-${++seq}`, provider: 'hetzner', region: 'fsn1', isManaged: true, providerId: `${9000 + seq}`, status: 'stopped', ...over })
    .returning();
  return s;
}
const row = async (id: string) => (await db.select().from(servers).where(eq(servers.id, id)))[0];

describe('stoppedServerAction', () => {
  it('warns on day 14 and 27, deletes on day 30, each once', () => {
    expect(stoppedServerAction(daysAgo(13), 0, NOW)).toBeNull();
    expect(stoppedServerAction(daysAgo(14), 0, NOW)).toBe('first-warning');
    expect(stoppedServerAction(daysAgo(20), 1, NOW)).toBeNull();
    expect(stoppedServerAction(daysAgo(27), 1, NOW)).toBe('final-warning');
    expect(stoppedServerAction(daysAgo(28), 2, NOW)).toBeNull();
    expect(stoppedServerAction(daysAgo(30), 2, NOW)).toBe('delete');
    // A sweep that missed the warnings still warns first on day 27 rather than deleting early.
    expect(stoppedServerAction(daysAgo(27.5), 0, NOW)).toBe('final-warning');
  });
});

describe.skipIf(!TEST_URL)('stopped managed servers (real Postgres)', () => {
  const cleanup = () => db.execute(sql`delete from organizations where name like 'stopped-test-%'`);
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });
  beforeEach(async () => {
    for (const fn of Object.values(h)) fn.mockReset();
    h.destroy.mockResolvedValue(undefined);
    await cleanup();
  });

  it('follows the 14 / 27 / 30 day schedule for a server off because the wallet ran dry', async () => {
    const o = await makeOrg();
    const s = await makeServer(o.id, { statusMessage: 'infra_credits_stopped', stoppedAt: daysAgo(15) });
    await stoppedServerService.sweep(NOW);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn.mock.calls[0][1]).toMatchObject({ serverName: s.name, final: false });
    expect(h.warn.mock.calls[0][1].deleteOn.toISOString()).toBe(new Date(daysAgo(15).getTime() + 30 * 86_400_000).toISOString());
    expect((await row(s.id)).stopWarningStep).toBe(1);
    await stoppedServerService.sweep(NOW);
    expect(h.warn).toHaveBeenCalledTimes(1); // not twice

    await db.update(servers).set({ stoppedAt: daysAgo(28) }).where(eq(servers.id, s.id));
    await stoppedServerService.sweep(NOW);
    expect(h.warn.mock.calls[1][1]).toMatchObject({ final: true });

    await db.update(servers).set({ stoppedAt: daysAgo(31) }).where(eq(servers.id, s.id));
    await stoppedServerService.sweep(NOW);
    expect(h.destroy).toHaveBeenCalledTimes(1);
    expect(await row(s.id)).toBeUndefined();
    expect(h.deleted).toHaveBeenCalledTimes(1);
  });

  it('stops the clock once the organization pays again, even if the server stays off', async () => {
    const o = await makeOrg({ billingStatus: 'active', plan: 'hobby' });
    const s = await makeServer(o.id, { statusMessage: 'billing_suspended', stoppedAt: daysAgo(40), stopWarningStep: 2 });
    await stoppedServerService.sweep(NOW);
    expect(h.destroy).not.toHaveBeenCalled();
    expect((await row(s.id)).stoppedAt).toBeNull();
  });

  it('starts the clock for servers stopped before this was tracked, and never touches ones the user stopped', async () => {
    const o = await makeOrg({ billingStatus: 'suspended' });
    const legacy = await makeServer(o.id, { statusMessage: 'billing_suspended', stoppedAt: null });
    const byUser = await makeServer(o.id, { statusMessage: null, stoppedAt: daysAgo(60) });
    await stoppedServerService.sweep(NOW);
    expect((await row(legacy.id)).stoppedAt?.toISOString()).toBe(NOW.toISOString());
    expect(await row(byUser.id)).toBeDefined();
    expect(h.destroy).not.toHaveBeenCalled();
  });

  it('clears the clock of a server that is running again', async () => {
    const o = await makeOrg();
    const s = await makeServer(o.id, { status: 'running', statusMessage: null, stoppedAt: daysAgo(20), stopWarningStep: 1 });
    await stoppedServerService.sweep(NOW);
    const after = await row(s.id);
    expect(after.stoppedAt).toBeNull();
    expect(after.stopWarningStep).toBe(0);
  });
});
