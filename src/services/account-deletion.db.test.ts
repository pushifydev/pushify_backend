import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * Organization and account deletion requests against a real Postgres. Runs only when
 * ACCOUNT_DELETION_TEST_DATABASE_URL points at a disposable database with migrations applied
 * (e.g. the local scratch DB pushify_credit_test). The db module is replaced with a pool on that
 * URL, so nothing here reaches the app's DATABASE_URL. Stripe, SSH, Hetzner and email are fakes.
 */
const TEST_URL = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  cancel: vi.fn(),
  revoke: vi.fn(),
  stopServer: vi.fn(),
  pause: vi.fn(),
  scheduledEmail: vi.fn(),
  restoredEmail: vi.fn(),
}));

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.ACCOUNT_DELETION_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 4 });
  return { db: drizzle(pool, { schema }), __pool: pool };
});
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/stripe')>();
  return {
    ...actual,
    getStripe: () => ({
      subscriptions: { cancel: h.cancel, retrieve: async () => ({ schedule: null }) },
      subscriptionSchedules: { retrieve: vi.fn(), release: vi.fn() },
    }),
  };
});
vi.mock('./server.service', () => ({ revokePushifyAccess: h.revoke }));
vi.mock('../lib/project-remote-cleanup', () => ({ pauseProjectContainers: h.pause }));
vi.mock('./organization-billing.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./organization-billing.service')>();
  return { ...actual, stopManagedServerForBillingSuspension: h.stopServer };
});
vi.mock('../lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email')>();
  return { ...actual, sendDeletionScheduledEmail: h.scheduledEmail, sendDeletionRestoredEmail: h.restoredEmail };
});

import { eq, sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import {
  apiKeys,
  gitIntegrations,
  organizationMembers,
  organizations,
  projects,
  purchasedDomains,
  servers,
  userSessions,
  users,
} from '../db/schema';
import { hashPassword } from '../lib/password';
import { isOrganizationPendingDeletion } from '../lib/deletion-lock';
import { accountDeletionService, DELETION_STATUS_MESSAGE } from './account-deletion.service';
import { assertOrganizationCanMutateResources, getOrganizationBillingStatus } from './organization-billing.service';
import { authService } from './auth.service';

const PASSWORD = 'correct horse battery staple';
const NOW = new Date('2026-10-01T12:00:00Z');
let seq = 0;

async function makeUser() {
  seq++;
  const [u] = await db
    .insert(users)
    .values({ email: `deletion-test-${Date.now()}-${seq}@example.com`, name: 'deletion-test', passwordHash: await hashPassword(PASSWORD) })
    .returning();
  return u;
}

async function makeOrg(owner: string, over: Partial<typeof organizations.$inferInsert> = {}) {
  seq++;
  const [o] = await db
    .insert(organizations)
    .values({ name: `deletion-test-${seq}`, slug: `deletion-test-${Date.now()}-${seq}`, plan: 'free', ...over })
    .returning();
  await db.insert(organizationMembers).values({ organizationId: o.id, userId: owner, role: 'owner' });
  return o;
}

async function fillOrg(orgId: string, userId: string) {
  const [managed] = await db
    .insert(servers)
    .values({ organizationId: orgId, name: 'managed-1', provider: 'hetzner', region: 'fsn1', isManaged: true, status: 'running', providerId: '123' })
    .returning();
  const [byos] = await db
    .insert(servers)
    .values({
      organizationId: orgId,
      name: 'my-vps',
      provider: 'self_hosted',
      region: 'custom',
      isManaged: false,
      status: 'running',
      ipv4: '203.0.113.9',
      sshPublicKey: 'ssh-rsa AAAA pushify-x',
      sshPrivateKey: 'encrypted-key',
      rootPassword: 'encrypted-password',
      setupStatus: 'completed',
    })
    .returning();
  const [shared] = await db.insert(projects).values({ organizationId: orgId, name: 'on-runner', slug: `runner-${seq}` }).returning();
  const [onByos] = await db
    .insert(projects)
    .values({ organizationId: orgId, name: 'on-byos', slug: `byos-${seq}`, serverId: byos.id })
    .returning();
  await db.insert(apiKeys).values({ organizationId: orgId, userId, name: 'ci', prefix: 'pk_test', keyHash: `h${Date.now()}${seq}` });
  await db.insert(purchasedDomains).values({
    organizationId: orgId,
    domainName: `deletion-test-${Date.now()}-${seq}.dev`,
    purchasePriceCents: 1500,
    wholesalePriceCents: 1000,
    expiresAt: new Date('2027-10-01T00:00:00Z'),
  });
  return { managed, byos, shared, onByos };
}

const org = async (id: string) => (await db.select().from(organizations).where(eq(organizations.id, id)))[0];
const user = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0];

async function httpError(p: Promise<unknown>): Promise<HTTPException> {
  try {
    await p;
  } catch (err) {
    if (err instanceof HTTPException) return err;
    throw err;
  }
  throw new Error('expected an HTTPException');
}

describe.skipIf(!TEST_URL)('account deletion (real Postgres)', () => {
  const cleanup = async () => {
    await db.execute(sql`delete from organizations where name like 'deletion-test-%'`);
    await db.execute(sql`delete from users where email like 'deletion-test-%'`);
  };
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });
  beforeEach(() => {
    for (const fn of Object.values(h)) fn.mockReset();
    h.cancel.mockResolvedValue({ status: 'canceled' });
    h.stopServer.mockResolvedValue(true);
    h.pause.mockResolvedValue(true);
    h.revoke.mockResolvedValue({ keyRemoved: false, manualCommand: "sed -i '/ pushify-x$/d' /root/.ssh/authorized_keys", reason: 'ECONNREFUSED' });
  });

  describe('organization', () => {
    it('refuses a wrong name, a wrong password, and anyone but the owner', async () => {
      const owner = await makeUser();
      const o = await makeOrg(owner.id);
      expect((await httpError(accountDeletionService.requestOrganizationDeletion(o.id, owner.id, { confirmName: 'nope', password: PASSWORD }, 'en'))).status).toBe(400);
      expect((await httpError(accountDeletionService.requestOrganizationDeletion(o.id, owner.id, { confirmName: o.name, password: 'wrong' }, 'en'))).status).toBe(400);

      const admin = await makeUser();
      await db.insert(organizationMembers).values({ organizationId: o.id, userId: admin.id, role: 'admin' });
      expect((await httpError(accountDeletionService.requestOrganizationDeletion(o.id, admin.id, { confirmName: o.name, password: PASSWORD }, 'en'))).status).toBe(403);
      expect((await org(o.id)).deletionScheduledFor).toBeNull();
      expect(h.cancel).not.toHaveBeenCalled();
    });

    it('locks everything at once and schedules the purge 30 days out', async () => {
      const owner = await makeUser();
      const o = await makeOrg(owner.id, { plan: 'pro', stripeSubscriptionId: 'sub_del_1', infraWalletBalanceCents: 1234, includedCreditCents: 1800 });
      const f = await fillOrg(o.id, owner.id);

      const result = await accountDeletionService.requestOrganizationDeletion(o.id, owner.id, { confirmName: o.name, password: PASSWORD }, 'en', NOW);

      expect(result.scheduledFor.toISOString()).toBe('2026-10-31T12:00:00.000Z');
      expect(result.walletBalanceCents).toBe(1234);
      const after = await org(o.id);
      expect(after.deletionScheduledFor?.toISOString()).toBe('2026-10-31T12:00:00.000Z');
      expect(after.deletionRequestedBy).toBe(owner.id);
      // Subscription ended now, on our side too; included credit reset.
      expect(h.cancel).toHaveBeenCalledWith('sub_del_1', { invoice_now: false, prorate: false });
      expect(after.plan).toBe('free');
      expect(after.stripeSubscriptionId).toBeNull();
      expect(after.includedCreditCents).toBe(0);
      // Keys revoked, domains stop renewing.
      expect(await db.select().from(apiKeys).where(eq(apiKeys.organizationId, o.id))).toHaveLength(0);
      expect((await db.select().from(purchasedDomains).where(eq(purchasedDomains.organizationId, o.id)))[0].autoRenew).toBe(false);
      // Managed server powered off; runner project paused; the project on the user's server left running.
      expect(h.stopServer).toHaveBeenCalledWith(f.managed.id, o.id, DELETION_STATUS_MESSAGE);
      expect(h.pause).toHaveBeenCalledTimes(1);
      expect(h.pause.mock.calls[0][0].id).toBe(f.shared.id);
      const byosProject = (await db.select().from(projects).where(eq(projects.id, f.onByos.id)))[0];
      expect(byosProject.status).toBe('active');
      // Connected server: key removal attempted, stored credentials wiped, manual command returned.
      expect(h.revoke).toHaveBeenCalledTimes(1);
      const byos = (await db.select().from(servers).where(eq(servers.id, f.byos.id)))[0];
      expect(byos.sshPrivateKey).toBeNull();
      expect(byos.rootPassword).toBeNull();
      expect(result.servers).toEqual([
        expect.objectContaining({ serverId: f.byos.id, keyRemoved: false, manualCommand: expect.stringContaining('pushify-x') }),
      ]);
      expect(h.scheduledEmail).toHaveBeenCalledTimes(1);
      expect(h.scheduledEmail.mock.calls[0][1]).toMatchObject({ kind: 'organization', walletBalanceCents: 1234 });

      // Locked: gates and the request middleware's check.
      expect(await isOrganizationPendingDeletion(o.id)).toBe(true);
      expect(await getOrganizationBillingStatus(o.id)).toBe('suspended');
      expect((await httpError(assertOrganizationCanMutateResources(o.id, 'en'))).status).toBe(403);
      // A second request changes nothing.
      expect((await httpError(accountDeletionService.requestOrganizationDeletion(o.id, owner.id, { confirmName: o.name, password: PASSWORD }, 'en'))).status).toBe(409);
    });

    it('does not lock anything when Stripe cannot cancel the subscription', async () => {
      const owner = await makeUser();
      const o = await makeOrg(owner.id, { plan: 'hobby', stripeSubscriptionId: 'sub_del_2' });
      h.cancel.mockRejectedValue(new Error('stripe down'));
      await expect(
        accountDeletionService.requestOrganizationDeletion(o.id, owner.id, { confirmName: o.name, password: PASSWORD }, 'en', NOW),
      ).rejects.toThrow('stripe down');
      expect((await org(o.id)).deletionScheduledFor).toBeNull();
      expect((await org(o.id)).plan).toBe('hobby');
    });

    it('restores to an unlocked Free organization, once', async () => {
      const owner = await makeUser();
      const o = await makeOrg(owner.id, { plan: 'hobby', stripeSubscriptionId: 'sub_del_3', billingStatus: 'suspended' });
      await accountDeletionService.requestOrganizationDeletion(o.id, owner.id, { confirmName: o.name, password: PASSWORD }, 'en', NOW);

      await accountDeletionService.restoreOrganization(o.id, owner.id, 'en');
      const after = await org(o.id);
      expect(after.deletionScheduledFor).toBeNull();
      expect(after.deletionRequestedAt).toBeNull();
      expect(after.plan).toBe('free');
      expect(after.billingStatus).toBe('active');
      expect(await isOrganizationPendingDeletion(o.id)).toBe(false);
      await expect(assertOrganizationCanMutateResources(o.id, 'en')).resolves.toBeUndefined();
      expect(h.restoredEmail).toHaveBeenCalledTimes(1);
      expect((await httpError(accountDeletionService.restoreOrganization(o.id, owner.id, 'en'))).status).toBe(409);
    });
  });

  describe('account', () => {
    it('is blocked while the user owns an organization with other members', async () => {
      const owner = await makeUser();
      const o = await makeOrg(owner.id);
      const member = await makeUser();
      await db.insert(organizationMembers).values({ organizationId: o.id, userId: member.id, role: 'member' });
      const err = await httpError(accountDeletionService.requestAccountDeletion(owner.id, { confirmEmail: owner.email, password: PASSWORD }, 'en', NOW));
      expect(err.status).toBe(409);
      expect((await user(owner.id)).deletionScheduledFor).toBeNull();
      expect((await org(o.id)).deletionScheduledFor).toBeNull();
    });

    it('schedules the account and its organization, signs out, and refuses sign-in with a restore token', async () => {
      const u = await makeUser();
      const o = await makeOrg(u.id);
      await db.insert(userSessions).values({ userId: u.id, tokenHash: `t${Date.now()}`, expiresAt: new Date(Date.now() + 86_400_000) });
      await db.insert(gitIntegrations).values({ userId: u.id, provider: 'github', providerAccountId: '1', accessToken: 'enc' });

      const result = await accountDeletionService.requestAccountDeletion(u.id, { confirmEmail: u.email.toUpperCase(), password: PASSWORD }, 'en', NOW);
      expect(result.organizations).toEqual([o.name]);
      expect((await user(u.id)).deletionScheduledFor?.toISOString()).toBe('2026-10-31T12:00:00.000Z');
      expect((await org(o.id)).deletionScheduledFor).not.toBeNull();
      expect(await db.select().from(userSessions).where(eq(userSessions.userId, u.id))).toHaveLength(0);
      expect(await db.select().from(gitIntegrations).where(eq(gitIntegrations.userId, u.id))).toHaveLength(0);

      const err = await httpError(authService.createSession(u.id, 'refresh-token'));
      expect(err.status).toBe(403);
      const cause = err.cause as { code: string; details: { restoreToken: string; scheduledFor: string } };
      expect(cause.code).toBe('ACCOUNT_PENDING_DELETION');
      expect(await db.select().from(userSessions).where(eq(userSessions.userId, u.id))).toHaveLength(0);

      await accountDeletionService.restoreAccount(cause.details.restoreToken, 'en');
      expect((await user(u.id)).deletionScheduledFor).toBeNull();
      expect((await org(o.id)).deletionScheduledFor).toBeNull();
      await expect(authService.createSession(u.id, 'refresh-token-2')).resolves.toBeUndefined();
    });

    it('restoring an account leaves an organization deleted separately before it scheduled', async () => {
      const u = await makeUser();
      const first = await makeOrg(u.id);
      await accountDeletionService.requestOrganizationDeletion(first.id, u.id, { confirmName: first.name, password: PASSWORD }, 'en', new Date('2026-09-30T00:00:00Z'));
      const second = await makeOrg(u.id);
      await accountDeletionService.requestAccountDeletion(u.id, { confirmEmail: u.email, password: PASSWORD }, 'en', NOW);

      const err = await httpError(authService.createSession(u.id, 'r'));
      const { restoreToken } = (err.cause as { details: { restoreToken: string } }).details;
      await accountDeletionService.restoreAccount(restoreToken, 'en');
      expect((await org(second.id)).deletionScheduledFor).toBeNull();
      expect((await org(first.id)).deletionScheduledFor).not.toBeNull();
    });

    it('rejects a restore token that is not one', async () => {
      expect((await httpError(accountDeletionService.restoreAccount('not-a-token', 'en'))).status).toBe(401);
    });
  });
});
