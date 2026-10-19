import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * Wallet credits per Stripe checkout session against a real Postgres. Runs only when
 * WALLET_CREDIT_TEST_DATABASE_URL points at a disposable database with migrations applied
 * (e.g. `createdb pushify_wallet_test` + `DATABASE_URL=… npx tsx src/migrate.ts`). The db module
 * is replaced with a pool on that URL, so nothing here can reach the app's DATABASE_URL.
 */
const TEST_URL = process.env.WALLET_CREDIT_TEST_DATABASE_URL;

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.WALLET_CREDIT_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 8 });
  return { db: drizzle(pool, { schema }), __pool: pool };
});
vi.mock('./admin-notify.service', () => ({ adminNotify: vi.fn() }));

import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { organizations, infraWalletTransactions } from '../db/schema';
import { infraBillingService } from './infra-billing.service';

let seq = 0;

async function makeOrg(balance = 0) {
  seq++;
  const [row] = await db
    .insert(organizations)
    .values({ name: `wallet-credit-test-${seq}`, slug: `wallet-credit-test-${Date.now()}-${seq}`, infraWalletBalanceCents: balance })
    .returning();
  return row;
}

const balanceOf = async (id: string) =>
  (await db.select({ b: organizations.infraWalletBalanceCents }).from(organizations).where(eq(organizations.id, id)))[0].b;
const txs = (id: string) => db.select().from(infraWalletTransactions).where(eq(infraWalletTransactions.organizationId, id));

describe.skipIf(!TEST_URL)('creditWallet (real Postgres)', () => {
  beforeAll(async () => {
    await db.execute(sql`delete from organizations where name like 'wallet-credit-test-%'`);
  });
  afterAll(async () => {
    await db.execute(sql`delete from organizations where name like 'wallet-credit-test-%'`);
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });

  it('credits a checkout session once when webhook and confirm race', async () => {
    const o = await makeOrg(100);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => infraBillingService.creditWallet(o.id, 2500, 'Stripe top-up $25.00', 'cs_test_race')),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results.every((r) => r.balanceAfterCents === 2600)).toBe(true);
    expect(await balanceOf(o.id)).toBe(2600);
    const rows = await txs(o.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ stripeCheckoutSessionId: 'cs_test_race', amountCents: 2500, balanceAfterCents: 2600 });

    const again = await infraBillingService.creditWallet(o.id, 2500, 'Stripe top-up $25.00', 'cs_test_race');
    expect(again).toEqual({ balanceAfterCents: 2600, created: false });
    expect(await balanceOf(o.id)).toBe(2600);
  });

  it('credits without a session id every time and distinct sessions separately', async () => {
    const o = await makeOrg();
    await Promise.all([
      infraBillingService.creditWallet(o.id, 100, 'manual'),
      infraBillingService.creditWallet(o.id, 100, 'manual'),
      infraBillingService.creditWallet(o.id, 300, 'a', 'cs_test_a'),
      infraBillingService.creditWallet(o.id, 500, 'b', 'cs_test_b'),
    ]);
    expect(await balanceOf(o.id)).toBe(1000);
    expect(await txs(o.id)).toHaveLength(4);
  });

  it('the same session id in another organization is a separate credit', async () => {
    const a = await makeOrg();
    const b = await makeOrg();
    await infraBillingService.creditWallet(a.id, 700, 'x', 'cs_test_shared');
    const r = await infraBillingService.creditWallet(b.id, 700, 'x', 'cs_test_shared');
    expect(r.created).toBe(true);
    expect(await balanceOf(b.id)).toBe(700);
  });
});
