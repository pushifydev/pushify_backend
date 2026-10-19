import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * Wallet credit/refund/debit races against a real Postgres. Runs only when
 * INFRA_WALLET_TEST_DATABASE_URL points at a disposable database with migrations applied
 * (e.g. `createdb pushify_wallet_test` + `DATABASE_URL=… npx tsx src/migrate.ts`). The db module
 * is replaced with a pool on that URL, so nothing here can reach the app's DATABASE_URL.
 */
const TEST_URL = process.env.INFRA_WALLET_TEST_DATABASE_URL;

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.INFRA_WALLET_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 10 });
  return { db: drizzle(pool, { schema }), __pool: pool };
});
vi.mock('./admin-notify.service', () => ({ adminNotify: vi.fn() }));

import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { organizations, infraWalletTransactions } from '../db/schema';
import { infraBillingService } from './infra-billing.service';

let seq = 0;

async function makeOrg(balance: number) {
  seq++;
  const [row] = await db
    .insert(organizations)
    .values({
      name: `wallet-test-${seq}`,
      slug: `wallet-test-${Date.now()}-${seq}`,
      plan: 'hobby',
      infraWalletBalanceCents: balance,
    })
    .returning();
  return row;
}

const balanceOf = async (id: string) =>
  (await db.select().from(organizations).where(eq(organizations.id, id)))[0].infraWalletBalanceCents;
const ledger = (id: string) =>
  db.select().from(infraWalletTransactions).where(eq(infraWalletTransactions.organizationId, id));

describe.skipIf(!TEST_URL)('infra wallet concurrency (real Postgres)', () => {
  beforeAll(async () => {
    await db.execute(sql`delete from organizations where name like 'wallet-test-%'`);
  });
  afterAll(async () => {
    await db.execute(sql`delete from organizations where name like 'wallet-test-%'`);
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });

  it('parallel debits, credits and refunds all land in the balance and the ledger', async () => {
    const o = await makeOrg(10_000);
    const ops: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      ops.push(infraBillingService.debitWallet(o.id, 100, 'adjustment', `debit ${i}`));
      ops.push(infraBillingService.creditWallet(o.id, 50, `credit ${i}`));
      ops.push(infraBillingService.refundWallet(o.id, 25, `refund ${i}`));
    }
    await Promise.all(ops);

    // 10_000 - 10*100 + 10*50 + 10*25
    expect(await balanceOf(o.id)).toBe(9_750);

    const rows = await ledger(o.id);
    expect(rows).toHaveLength(30);
    expect(rows.reduce((sum, r) => sum + r.amountCents, 0)).toBe(-250);
    // The last serialized write recorded the balance the org actually has.
    expect(rows.map((r) => r.balanceAfterCents)).toContain(9_750);
  });

  it('a credit returns the stored balance', async () => {
    const o = await makeOrg(300);
    const res = await infraBillingService.creditWallet(o.id, 200, 'topup');
    expect(res).toEqual({ balanceAfterCents: 500, created: true });
    expect(await infraBillingService.refundWallet(o.id, 50, 'refund')).toBe(550);
    expect(await balanceOf(o.id)).toBe(550);
  });
});
