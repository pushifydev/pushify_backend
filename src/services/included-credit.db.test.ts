import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * Included server credit against a real Postgres. Runs only when
 * INCLUDED_CREDIT_TEST_DATABASE_URL points at a disposable database with migrations applied
 * (e.g. `createdb pushify_credit_test` + `DATABASE_URL=… npx tsx src/migrate.ts`). The db module
 * is replaced with a pool on that URL, so nothing here can reach the app's DATABASE_URL.
 */
const TEST_URL = process.env.INCLUDED_CREDIT_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({ retrieve: vi.fn() }));

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.INCLUDED_CREDIT_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 4 });
  return { db: drizzle(pool, { schema }), __pool: pool };
});
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/stripe')>();
  return { ...actual, getStripe: () => ({ subscriptions: { retrieve: h.retrieve } }) };
});

import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { organizations, includedCreditGrants } from '../db/schema';
import { includedCreditService } from './included-credit.service';
import { infraBillingService } from './infra-billing.service';

const T = (s: string) => new Date(s);
let seq = 0;

async function makeOrg(over: Partial<typeof organizations.$inferInsert> = {}) {
  seq++;
  const [row] = await db
    .insert(organizations)
    .values({
      name: `credit-test-${seq}`,
      slug: `credit-test-${Date.now()}-${seq}`,
      plan: 'hobby',
      stripeSubscriptionId: `sub_test_${seq}`,
      billingStatus: 'active',
      stripeCurrentPeriodStart: T('2026-09-01T00:00:00Z'),
      stripeCurrentPeriodEnd: T('2026-10-01T00:00:00Z'),
      billingInterval: 'month',
      ...over,
    })
    .returning();
  return row;
}

const org = async (id: string) => (await db.select().from(organizations).where(eq(organizations.id, id)))[0];
const grants = (id: string) => db.select().from(includedCreditGrants).where(eq(includedCreditGrants.organizationId, id));

describe.skipIf(!TEST_URL)('included credit (real Postgres)', () => {
  beforeAll(async () => {
    await db.execute(sql`delete from organizations where name like 'credit-test-%'`);
  });
  beforeEach(() => h.retrieve.mockReset());
  afterAll(async () => {
    await db.execute(sql`delete from organizations where name like 'credit-test-%'`);
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });

  it('grants a period once, even when called concurrently', async () => {
    const o = await makeOrg();
    const now = T('2026-09-10T00:00:00Z');
    const results = await Promise.all(Array.from({ length: 6 }, () => includedCreditService.ensurePeriodGrant(o.id, now)));
    expect(results.filter((r) => r > 0)).toEqual([900]);
    expect((await org(o.id)).includedCreditCents).toBe(900);
    expect((await grants(o.id)).filter((g) => g.kind === 'period')).toHaveLength(1);
    expect(await includedCreditService.ensurePeriodGrant(o.id, now)).toBe(0);
  });

  it('a new period replaces the remainder (no roll-over) and records the expiry', async () => {
    const o = await makeOrg();
    await includedCreditService.ensurePeriodGrant(o.id, T('2026-09-10T00:00:00Z'));
    await db.update(organizations).set({ includedCreditCents: 250 }).where(eq(organizations.id, o.id));
    h.retrieve.mockResolvedValue({
      id: o.stripeSubscriptionId,
      current_period_start: T('2026-10-01T00:00:00Z').getTime() / 1000,
      current_period_end: T('2026-11-01T00:00:00Z').getTime() / 1000,
      items: { data: [{ price: { recurring: { interval: 'month' } } }] },
    });
    expect(await includedCreditService.ensurePeriodGrant(o.id, T('2026-10-02T00:00:00Z'))).toBe(900);
    const after = await org(o.id);
    expect(after.includedCreditCents).toBe(900);
    expect(after.includedCreditPeriodKey).toBe('2026-10-01');
    const g = await grants(o.id);
    expect(g.find((x) => x.kind === 'expire')).toMatchObject({ periodKey: '2026-09-01', amountCents: -250 });
  });

  it('yearly subscriptions get the credit every month', async () => {
    const o = await makeOrg({
      plan: 'pro',
      billingInterval: 'year',
      stripeCurrentPeriodStart: T('2026-01-15T00:00:00Z'),
      stripeCurrentPeriodEnd: T('2027-01-15T00:00:00Z'),
    });
    for (const day of ['2026-01-20', '2026-02-20', '2026-03-20', '2026-03-25']) {
      await includedCreditService.ensurePeriodGrant(o.id, T(`${day}T00:00:00Z`));
    }
    const periods = (await grants(o.id)).filter((g) => g.kind === 'period').map((g) => g.periodKey).sort();
    expect(periods).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
    expect((await org(o.id)).includedCreditCents).toBe(1800);
  });

  it('past_due gets nothing; paying catches the same period up', async () => {
    const o = await makeOrg({ billingStatus: 'past_due' });
    expect(await includedCreditService.ensurePeriodGrant(o.id, T('2026-09-05T00:00:00Z'))).toBe(0);
    await db.update(organizations).set({ billingStatus: 'active' }).where(eq(organizations.id, o.id));
    expect(await includedCreditService.ensurePeriodGrant(o.id, T('2026-09-06T00:00:00Z'))).toBe(900);
    expect((await org(o.id)).includedCreditPeriodKey).toBe('2026-09-01');
  });

  it('upgrades add the prorated difference once; down-then-up adds nothing more', async () => {
    const o = await makeOrg();
    await includedCreditService.ensurePeriodGrant(o.id, T('2026-09-01T00:00:00Z'));
    await db.update(organizations).set({ plan: 'business' }).where(eq(organizations.id, o.id));
    const mid = T('2026-09-16T00:00:00Z'); // exactly half of a 30-day period left
    expect(await includedCreditService.grantUpgradeDifference(o.id, 'hobby', 'business', mid)).toBe(1800);
    expect(await includedCreditService.grantUpgradeDifference(o.id, 'hobby', 'business', mid)).toBe(0);
    await db.update(organizations).set({ plan: 'pro' }).where(eq(organizations.id, o.id));
    await db.update(organizations).set({ plan: 'business' }).where(eq(organizations.id, o.id));
    expect(await includedCreditService.grantUpgradeDifference(o.id, 'pro', 'business', mid)).toBe(0);
    expect((await org(o.id)).includedCreditCents).toBe(2700);
  });

  it('a last-day upgrade gets only a day of difference', async () => {
    const o = await makeOrg();
    await includedCreditService.ensurePeriodGrant(o.id, T('2026-09-01T00:00:00Z'));
    await db.update(organizations).set({ plan: 'business' }).where(eq(organizations.id, o.id));
    expect(await includedCreditService.grantUpgradeDifference(o.id, 'hobby', 'business', T('2026-09-30T00:00:00Z'))).toBe(120);
  });

  it('downgrades take nothing back', async () => {
    const o = await makeOrg({ plan: 'business' });
    await includedCreditService.ensurePeriodGrant(o.id, T('2026-09-01T00:00:00Z'));
    await db.update(organizations).set({ plan: 'hobby' }).where(eq(organizations.id, o.id));
    expect(await includedCreditService.grantUpgradeDifference(o.id, 'business', 'hobby', T('2026-09-10T00:00:00Z'))).toBe(0);
    expect((await org(o.id)).includedCreditCents).toBe(4500);
  });

  it('cancellation expires the remainder; usage is reported for refunds', async () => {
    const o = await makeOrg({ plan: 'pro' });
    await includedCreditService.ensurePeriodGrant(o.id, T('2026-09-01T00:00:00Z'));
    await db.update(organizations).set({ includedCreditCents: 1300 }).where(eq(organizations.id, o.id));
    expect(await includedCreditService.usageThisPeriod(o.id)).toMatchObject({ grantedCents: 1800, remainingCents: 1300, usedCents: 500 });
    expect(await includedCreditService.expire(o.id, 'canceled')).toBe(1300);
    expect((await org(o.id)).includedCreditCents).toBe(0);
    expect(await includedCreditService.usageThisPeriod(o.id)).toMatchObject({ usedCents: 500, remainingCents: 0 });
  });

  it('server charges spend included credit first, then the wallet; the ledger shows the wallet part', async () => {
    const o = await makeOrg({ infraWalletBalanceCents: 100 });
    await includedCreditService.ensurePeriodGrant(o.id, T('2026-09-01T00:00:00Z'));
    expect(await infraBillingService.debitWallet(o.id, 700, 'server_hourly_charge', 'test')).toBe(100);
    expect((await org(o.id)).includedCreditCents).toBe(200);
    expect(await infraBillingService.debitWallet(o.id, 250, 'server_hourly_charge', 'test')).toBe(50);
    expect((await org(o.id)).includedCreditCents).toBe(0);
    // Not enough left in both together: refused (the server gets stopped, as before).
    expect(await infraBillingService.debitWallet(o.id, 60, 'server_hourly_charge', 'test')).toBeNull();
    // Domains never touch included credit.
    await db.update(organizations).set({ includedCreditCents: 500 }).where(eq(organizations.id, o.id));
    expect(await infraBillingService.debitWallet(o.id, 60, 'domain_purchase', 'test')).toBeNull();
  });

  it('Hobby can provision the entry server on its $9 alone', async () => {
    const o = await makeOrg({ infraWalletBalanceCents: 0 });
    await includedCreditService.ensurePeriodGrant(o.id, T('2026-09-01T00:00:00Z'));
    const quote = { customerPriceMonthlyCents: 765 } as Parameters<typeof infraBillingService.assertWalletCanProvision>[2];
    await expect(infraBillingService.assertWalletCanProvision(o.id, 'hobby', quote, 'en')).resolves.toBeUndefined();
    const pricey = { customerPriceMonthlyCents: 950 } as typeof quote;
    await expect(infraBillingService.assertWalletCanProvision(o.id, 'hobby', pricey, 'en')).rejects.toThrow();
  });

  it('the hourly sweep grants every due paid org and skips the rest', async () => {
    const due = await makeOrg({ plan: 'business' });
    const free = await makeOrg({ plan: 'free' });
    const pastDue = await makeOrg({ billingStatus: 'past_due' });
    await includedCreditService.grantDuePeriods(T('2026-09-03T00:00:00Z'));
    expect((await org(due.id)).includedCreditCents).toBe(4500);
    expect((await org(free.id)).includedCreditCents).toBe(0);
    expect((await org(pastDue.id)).includedCreditCents).toBe(0);
  });
});
