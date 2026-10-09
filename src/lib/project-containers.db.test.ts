import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/** Slug conflicts between organizations on one shared runner, against a real Postgres. */
const TEST_URL = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL;

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.ACCOUNT_DELETION_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 2 });
  return { db: drizzle(pool, { schema }), __pool: pool };
});
// Every serverless project lands on the same runner
vi.mock('./runner-routing', () => ({ pickRunnerServerId: () => 'runner-1' }));

import { sql } from 'drizzle-orm';
import { db } from '../db';
import { organizations, projects, servers } from '../db/schema';
import { runnerSlugConflicts } from './project-containers';

const PREFIX = 'slugconf-test-';
const ids = {} as Record<string, string>;

describe.skipIf(!TEST_URL)('runnerSlugConflicts (real Postgres)', () => {
  beforeAll(async () => {
    await db.execute(sql`delete from organizations where name like ${PREFIX + '%'}`);
    const stamp = Date.now();
    const slug = `sp${stamp}`;
    const org = async (n: string) =>
      (await db.insert(organizations).values({ name: `${PREFIX}${n}-${stamp}`, slug: `${PREFIX}${n}-${stamp}` }).returning())[0].id;
    const a = await org('a');
    const b = await org('b');
    const c = await org('c');
    const [own] = await db.insert(servers).values({ organizationId: c, name: 's', provider: 'self_hosted', region: 'x', isManaged: false }).returning();
    const p = async (organizationId: string, s: string, serverId: string | null = null, status: 'active' | 'paused' | 'deleted' = 'active') =>
      (await db.insert(projects).values({ organizationId, name: s, slug: s, serverId, status }).returning())[0].id;
    ids.mine = await p(a, slug);
    ids.sameSlugOtherOrg = await p(b, slug);
    ids.store = await p(b, `${slug}-store`);
    ids.staging = await p(b, `${slug}-staging`, null, 'paused');
    ids.deleted = await p(b, slug + '-pr-4', null, 'deleted');
    ids.ownServer = await p(c, slug, own.id);
    ids.slug = slug;
  });

  afterAll(async () => {
    await db.execute(sql`delete from organizations where name like ${PREFIX + '%'}`);
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });

  it('finds the same slug and deployer-suffixed slugs on the runner — not prefixes, deleted projects or own servers', async () => {
    const found = await runnerSlugConflicts({ id: ids.mine, slug: ids.slug, serverId: null });
    expect(found.map((f) => f.id).sort()).toEqual([ids.sameSlugOtherOrg, ids.staging].sort());
  });

  it('activeOnly ignores paused projects (pausing next to a suspended twin is safe)', async () => {
    const found = await runnerSlugConflicts({ id: ids.mine, slug: ids.slug, serverId: null }, { activeOnly: true });
    expect(found.map((f) => f.id)).toEqual([ids.sameSlugOtherOrg]);
  });

  it('a project on its own server has no runner conflicts', async () => {
    expect(await runnerSlugConflicts({ id: ids.ownServer, slug: ids.slug, serverId: 'own' })).toEqual([]);
  });
});
