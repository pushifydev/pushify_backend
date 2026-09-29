import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/** Bulk upsert (what `pushify env push` calls) against a real Postgres (ACCOUNT_DELETION_TEST_DATABASE_URL). */
const TEST_URL = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL;

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.ACCOUNT_DELETION_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 4 });
  return { db: drizzle(pool, { schema }), __pool: pool };
});

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { environmentVariables, organizationMembers, organizations, projects, users } from '../db/schema';
import { decrypt, encrypt } from '../lib/encryption';
import { envVarService } from './envvar.service';

const ctx = {} as { orgId: string; projectId: string; userId: string };
const row = async (key: string) =>
  (await db.select().from(environmentVariables).where(and(eq(environmentVariables.projectId, ctx.projectId), eq(environmentVariables.key, key))))[0];

describe.skipIf(!TEST_URL)('env var bulk upsert (real Postgres)', () => {
  beforeAll(async () => {
    await db.execute(sql`delete from organizations where name like 'envbulk-test-%'`);
    const stamp = Date.now();
    const [o] = await db.insert(organizations).values({ name: `envbulk-test-${stamp}`, slug: `envbulk-test-${stamp}` }).returning();
    const [u] = await db.insert(users).values({ email: `envbulk-test-${stamp}@example.com`, name: 'u' }).returning();
    await db.insert(organizationMembers).values({ organizationId: o.id, userId: u.id, role: 'member' });
    const [p] = await db.insert(projects).values({ organizationId: o.id, name: 'p', slug: `envbulk-${stamp}` }).returning();
    Object.assign(ctx, { orgId: o.id, projectId: p.id, userId: u.id });
    await db.insert(environmentVariables).values({ projectId: p.id, key: 'STRIPE_KEY', valueEncrypted: encrypt('sk_live_abcdefgh'), isSecret: true, environment: 'production' });
  });
  afterAll(async () => {
    await db.execute(sql`delete from organizations where name like 'envbulk-test-%'`);
    await db.execute(sql`delete from users where email like 'envbulk-test-%'`);
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });

  it('pushing back the masked copy from env pull leaves the secret untouched', async () => {
    const res = await envVarService.bulkCreate(ctx.projectId, ctx.orgId, ctx.userId, { variables: [{ key: 'STRIPE_KEY', value: 'sk****gh' }] }, 'en');
    expect(res.map((r) => r.action)).toEqual(['unchanged']);
    const after = await row('STRIPE_KEY');
    expect(decrypt(after.valueEncrypted)).toBe('sk_live_abcdefgh');
    expect(after.isSecret).toBe(true);
  });

  it('a new value without isSecret keeps the variable secret, and says so', async () => {
    const res = await envVarService.bulkCreate(ctx.projectId, ctx.orgId, ctx.userId, { variables: [{ key: 'STRIPE_KEY', value: 'sk_live_rotated1' }] }, 'en');
    expect(res[0]).toMatchObject({ action: 'updated', isSecret: true });
    const after = await row('STRIPE_KEY');
    expect(decrypt(after.valueEncrypted)).toBe('sk_live_rotated1');
    expect(after.isSecret).toBe(true);
  });

  it('refuses a lowercase name with the same rule the CLI checks', async () => {
    await expect(
      envVarService.bulkCreate(ctx.projectId, ctx.orgId, ctx.userId, { variables: [{ key: 'apiKey', value: 'x' }] }, 'en'),
    ).rejects.toMatchObject({ status: 400 });
  });
});
