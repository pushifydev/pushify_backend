import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * Retention periods against a real Postgres (ACCOUNT_DELETION_TEST_DATABASE_URL, a disposable
 * database with migrations applied).
 */
const TEST_URL = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL;

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.ACCOUNT_DELETION_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 4 });
  return { db: drizzle(pool, { schema }), __pool: pool };
});

import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { activityLogs, authEvents, deployments, organizations, projects, userSessions, users } from '../db/schema';
import { retentionService } from './retention.service';

const NOW = new Date('2026-10-01T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

describe.skipIf(!TEST_URL)('retention (real Postgres)', () => {
  const cleanup = async () => {
    await db.execute(sql`delete from organizations where name like 'retention-test-%'`);
    await db.execute(sql`delete from users where email like 'retention-test-%'`);
  };
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });

  it('keeps each record for its period and no longer', async () => {
    const [u] = await db.insert(users).values({ email: `retention-test-${Date.now()}@example.com`, name: 'r' }).returning();
    const [o] = await db.insert(organizations).values({ name: `retention-test-${Date.now()}`, slug: `retention-test-${Date.now()}` }).returning();
    const [p] = await db.insert(projects).values({ organizationId: o.id, name: 'p', slug: `retention-${Date.now()}` }).returning();

    await db.insert(activityLogs).values([
      { organizationId: o.id, userId: u.id, action: 'project.created', description: 'old', createdAt: daysAgo(400) },
      { organizationId: o.id, userId: u.id, action: 'project.created', description: 'recent', createdAt: daysAgo(300) },
    ]);
    await db.insert(authEvents).values([
      { userId: u.id, event: 'login', method: 'password', ipAddress: '198.51.100.1', createdAt: daysAgo(120) },
      { userId: u.id, event: 'login', method: 'password', ipAddress: '198.51.100.2', createdAt: daysAgo(30) },
    ]);
    // 13 old deployments and 1 recent one: the latest 10 overall keep their logs.
    const rows = Array.from({ length: 13 }, (_, i) => ({ projectId: p.id, buildLogs: `build ${i}`, deployLogs: `deploy ${i}`, createdAt: daysAgo(200 - i) }));
    rows.push({ projectId: p.id, buildLogs: 'build new', deployLogs: 'deploy new', createdAt: daysAgo(5) });
    await db.insert(deployments).values(rows);
    await db.insert(userSessions).values([
      { userId: u.id, tokenHash: `old-${Date.now()}`, expiresAt: daysAgo(3) },
      { userId: u.id, tokenHash: `live-${Date.now()}`, expiresAt: new Date(NOW.getTime() + 86_400_000) },
    ]);

    await retentionService.sweep(NOW);

    expect((await db.select().from(activityLogs).where(eq(activityLogs.organizationId, o.id))).map((a) => a.description)).toEqual(['recent']);
    expect((await db.select().from(authEvents).where(eq(authEvents.userId, u.id))).map((a) => a.ipAddress)).toEqual(['198.51.100.2']);
    const deps = await db.select().from(deployments).where(eq(deployments.projectId, p.id));
    expect(deps).toHaveLength(14); // rows stay
    const withLogs = deps.filter((d) => d.buildLogs !== null);
    expect(withLogs).toHaveLength(10);
    expect(withLogs.map((d) => d.buildLogs)).toContain('build new');
    expect(deps.filter((d) => d.buildLogs === null).every((d) => d.deployLogs === null)).toBe(true);
    expect((await db.select().from(userSessions).where(eq(userSessions.userId, u.id))).map((s) => s.tokenHash.split('-')[0])).toEqual(['live']);
  });
});
