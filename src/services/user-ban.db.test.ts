import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

/** Account bans against a real Postgres (ACCOUNT_DELETION_TEST_DATABASE_URL). */
const TEST_URL = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL;

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.ACCOUNT_DELETION_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 4 });
  return { db: drizzle(pool, { schema }), __pool: pool };
});

const mocks = vi.hoisted(() => ({
  pause: vi.fn(async () => true),
  bannedEmail: vi.fn(async () => undefined),
  reinstatedEmail: vi.fn(async () => undefined),
  projectEmail: vi.fn(async () => undefined),
  stopServer: vi.fn(async () => true),
  adminNotify: vi.fn(),
  autoBanAfter: { value: 0 },
}));

vi.mock('../lib/project-remote-cleanup', () => ({ pauseProjectContainers: mocks.pause, resumeProjectContainers: vi.fn(async () => true) }));
vi.mock('../lib/email', () => ({
  sendAccountBannedEmail: mocks.bannedEmail,
  sendAccountReinstatedEmail: mocks.reinstatedEmail,
  sendProjectSuspendedEmail: mocks.projectEmail,
  sendProjectReinstatedEmail: vi.fn(async () => undefined),
}));
vi.mock('./organization-billing.service', () => ({ stopManagedServerForBillingSuspension: mocks.stopServer }));
vi.mock('./admin-notify.service', () => ({ adminNotify: mocks.adminNotify }));
vi.mock('../config/env', async (importOriginal) => {
  const actual = (await importOriginal()) as { env: Record<string, unknown> };
  return {
    env: new Proxy(
      { ...actual.env, ABUSE_CONTACT_EMAIL: 'report@pushify.dev', FRONTEND_URL: 'https://pushify.dev' },
      { get: (t, k) => (k === 'ABUSE_AUTO_BAN_AFTER' ? mocks.autoBanAfter.value : (t as Record<string | symbol, unknown>)[k]) },
    ),
  };
});

import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { abuseActions, apiKeys, bannedIdentifiers, organizationMembers, organizations, projects, servers, userSessions, users } from '../db/schema';
import { assertSignupAllowed } from '../lib/user-ban';
import { userBanService } from './user-ban.service';
import { authService } from './auth.service';
import { apiKeyService } from './apikey.service';
import { abuseService } from './abuse.service';

const PREFIX = 'userban-test-';
const ctx = {} as { userId: string; adminId: string; orgId: string; projectIds: string[]; email: string };

async function makeAccount(tag: string, email: string) {
  const [u] = await db.insert(users).values({ email, name: tag, githubId: `${PREFIX}${tag}-gh-${Date.now()}` }).returning();
  const [o] = await db.insert(organizations).values({ name: `${PREFIX}${tag}-${Date.now()}`, slug: `${PREFIX}${tag}-${Date.now()}` }).returning();
  await db.insert(organizationMembers).values({ organizationId: o.id, userId: u.id, role: 'owner' });
  return { u, o };
}

describe.skipIf(!TEST_URL)('account bans (real Postgres)', () => {
  beforeAll(async () => {
    await db.execute(sql`delete from banned_identifiers where reason like ${PREFIX + '%'} or value like ${'%' + PREFIX + '%'}`);
    await db.execute(sql`delete from organizations where name like ${PREFIX + '%'}`);
    await db.execute(sql`delete from users where email like ${PREFIX + '%'} or email like ${'%userbantest%'}`);
    const email = `userbantest.${Date.now()}@gmail.com`;
    const { u, o } = await makeAccount('owner', email);
    const [admin] = await db.insert(users).values({ email: `${PREFIX}admin-${Date.now()}@example.com`, name: 'admin' }).returning();
    const p1 = (await db.insert(projects).values({ organizationId: o.id, name: 'a', slug: `${PREFIX}a-${Date.now()}` }).returning())[0].id;
    const p2 = (await db.insert(projects).values({ organizationId: o.id, name: 'b', slug: `${PREFIX}b-${Date.now()}` }).returning())[0].id;
    await db.insert(servers).values({ organizationId: o.id, name: 'm', provider: 'hetzner', region: 'fsn1', isManaged: true, status: 'running', providerId: '1' });
    await db.insert(userSessions).values({ userId: u.id, tokenHash: `${PREFIX}${Date.now()}`, expiresAt: new Date(Date.now() + 86_400_000) });
    await db.insert(apiKeys).values({ userId: u.id, organizationId: o.id, name: 'k', prefix: 'pk_live_x', keyHash: 'x'.repeat(64) });
    Object.assign(ctx, { userId: u.id, adminId: admin.id, orgId: o.id, projectIds: [p1, p2], email });
  });

  afterAll(async () => {
    await db.execute(sql`delete from banned_identifiers where user_id in (select id from users where email like ${'%userbantest%'})`);
    await db.execute(sql`delete from organizations where name like ${PREFIX + '%'}`);
    await db.execute(sql`delete from users where email like ${PREFIX + '%'} or email like ${'%userbantest%'}`);
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });

  beforeEach(() => {
    for (const m of [mocks.pause, mocks.bannedEmail, mocks.reinstatedEmail, mocks.projectEmail, mocks.stopServer, mocks.adminNotify]) m.mockClear();
  });

  it('bans: revokes sessions and keys, blocks identifiers, suspends projects, stops servers, sends one email', async () => {
    const res = await userBanService.banUser({ userId: ctx.userId, adminUserId: ctx.adminId, reason: 'Repeatedly deployed a VLESS relay', clause: 'proxy-vpn' });
    expect(res).toMatchObject({ projectsSuspended: 2, serversStopped: 1, apiKeysDeleted: 1, identifiersBlocked: 2 });

    const [u] = await db.select().from(users).where(eq(users.id, ctx.userId));
    expect(u.bannedAt).toBeInstanceOf(Date);
    expect(await db.select().from(userSessions).where(eq(userSessions.userId, ctx.userId))).toHaveLength(0);
    expect(await db.select().from(apiKeys).where(eq(apiKeys.userId, ctx.userId))).toHaveLength(0);
    const suspended = await db.select().from(projects).where(eq(projects.organizationId, ctx.orgId));
    expect(suspended.every((p) => p.suspendedAt && p.status === 'paused')).toBe(true);
    expect(mocks.stopServer).toHaveBeenCalledWith(expect.any(String), ctx.orgId, 'account_banned');
    // One account email, no per-project emails
    expect(mocks.bannedEmail).toHaveBeenCalledTimes(1);
    expect(mocks.projectEmail).not.toHaveBeenCalled();
    const actions = await db.select().from(abuseActions).where(and(eq(abuseActions.userId, ctx.userId), eq(abuseActions.action, 'ban')));
    expect(actions).toHaveLength(1);
    await expect(userBanService.banUser({ userId: ctx.userId, adminUserId: ctx.adminId, reason: 'again and again', clause: 'other' })).rejects.toMatchObject({ status: 409 });
  });

  it('a banned account gets no session from any sign-in path and no API access', async () => {
    await expect(authService.createSession(ctx.userId, `rt-${Date.now()}`)).rejects.toMatchObject({ status: 403 });
    // A key created behind the ban's back still does not work
    const raw = `pk_live_${Date.now()}`;
    await db.insert(apiKeys).values({ userId: ctx.userId, organizationId: ctx.orgId, name: 'late', prefix: 'pk_live_x', keyHash: createHash('sha256').update(raw).digest('hex') });
    expect(await apiKeyService.validate(raw)).toBeNull();
    await db.delete(apiKeys).where(eq(apiKeys.userId, ctx.userId));
  });

  it('the same person cannot sign up again with a Gmail dot/+tag variant of the email', async () => {
    const [local] = ctx.email.split('@');
    const variant = `${local.replace('.', '')}+again@googlemail.com`;
    await expect(assertSignupAllowed({ email: variant })).rejects.toMatchObject({ status: 403 });
    await expect(assertSignupAllowed({ email: `someone-else-${Date.now()}@example.com` })).resolves.toBeUndefined();
  });

  it('unbans: sign-in and sign-up allowed again; suspended projects stay suspended', async () => {
    await userBanService.unbanUser({ userId: ctx.userId, adminUserId: ctx.adminId, note: 'Appeal accepted' });
    await expect(authService.createSession(ctx.userId, `rt2-${Date.now()}`)).resolves.toBeUndefined();
    await expect(assertSignupAllowed({ email: ctx.email })).resolves.toBeUndefined();
    expect(await db.select().from(bannedIdentifiers).where(eq(bannedIdentifiers.userId, ctx.userId))).toHaveLength(0);
    const still = await db.select().from(projects).where(eq(projects.organizationId, ctx.orgId));
    expect(still.every((p) => p.suspendedAt)).toBe(true);
    expect(mocks.reinstatedEmail).toHaveBeenCalledTimes(1);
  });

  it('auto-ban (ABUSE_AUTO_BAN_AFTER) bans the owner once enough of their projects were suspended', async () => {
    const { u, o } = await makeAccount('auto', `userbantest-auto-${Date.now()}@example.com`);
    const ps = [];
    for (const n of ['x', 'y']) ps.push((await db.insert(projects).values({ organizationId: o.id, name: n, slug: `${PREFIX}${n}-${Date.now()}` }).returning())[0].id);
    mocks.autoBanAfter.value = 2;
    try {
      await abuseService.suspendProject({ projectId: ps[0], adminUserId: null, reason: 'auto one', clause: 'proxy-vpn', endsAt: null });
      expect(await userBanService.maybeAutoBan(ps[0])).toBe(false);
      await abuseService.suspendProject({ projectId: ps[1], adminUserId: null, reason: 'auto two', clause: 'proxy-vpn', endsAt: null });
      expect(await userBanService.maybeAutoBan(ps[1])).toBe(true);
      const [after] = await db.select().from(users).where(eq(users.id, u.id));
      expect(after.bannedAt).toBeInstanceOf(Date);
    } finally {
      mocks.autoBanAfter.value = 0;
    }
    // Off by default
    expect(await userBanService.maybeAutoBan(ps[1])).toBe(false);
  });
});
