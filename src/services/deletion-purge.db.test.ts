import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

/**
 * The permanent purge against a real Postgres (ACCOUNT_DELETION_TEST_DATABASE_URL, a disposable
 * database with migrations applied). Every external service — Hetzner, runners, Cloudflare,
 * rclone, GitHub, the registrar, Stripe, email — is a fake, so the test checks what is called and
 * what is left in the database.
 */
const TEST_URL = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL;

const h = vi.hoisted(() => ({
  listSnapshots: vi.fn(),
  deleteSnapshot: vi.fn(),
  deleteServer: vi.fn(),
  deleteSSHKey: vi.fn(),
  cleanupProject: vi.fn(),
  dnsDelete: vi.fn(),
  offsitePurge: vi.fn(),
  customerDel: vi.fn(),
  forwards: vi.fn(),
  deleteForward: vi.fn(),
  completedEmail: vi.fn(),
  reminderEmail: vi.fn(),
  adminNotify: vi.fn(),
}));

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.ACCOUNT_DELETION_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 4 });
  return { db: drizzle(pool, { schema }), __pool: pool };
});
vi.mock('../config/env', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/env')>();
  return { env: { ...actual.env, HETZNER_API_TOKEN: 'hz_test', STRIPE_SECRET_KEY: 'sk_test_x', BILLING_RECORD_RETENTION_YEARS: 10 } };
});
vi.mock('../providers', () => ({
  createProvider: () => ({
    listSnapshotIdsCreatedFrom: h.listSnapshots,
    deleteSnapshot: h.deleteSnapshot,
    deleteServer: h.deleteServer,
    deleteSSHKey: h.deleteSSHKey,
  }),
}));
vi.mock('./project.service', () => ({ projectService: { cleanupProjectContainers: h.cleanupProject } }));
vi.mock('../lib/cloudflare-dns', () => ({ deleteAutoSubdomainRecord: h.dnsDelete, hostnameOf: () => null }));
vi.mock('../repositories/preview.repository', () => ({ previewRepository: { findAllByProject: async () => [] } }));
vi.mock('./offsite-backup.service', () => ({ offsiteBackupService: { purgeOrganization: h.offsitePurge } }));
vi.mock('../lib/stripe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/stripe')>();
  return { ...actual, getStripe: () => ({ customers: { del: h.customerDel } }) };
});
vi.mock('../lib/registrar', () => ({
  getRegistrar: () => ({ listEmailForwardings: h.forwards, deleteEmailForwarding: h.deleteForward }),
}));
vi.mock('../lib/email', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/email')>();
  return { ...actual, sendDeletionCompletedEmail: h.completedEmail, sendDeletionReminderEmail: h.reminderEmail };
});
vi.mock('./admin-notify.service', () => ({ adminNotify: h.adminNotify }));

import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  authEvents,
  deletedOrganizations,
  deletionPurgeSteps,
  domains,
  infraWalletTransactions,
  organizationMembers,
  organizations,
  projects,
  purchasedDomains,
  servers,
  users,
} from '../db/schema';
import { deletionPurgeService } from './deletion-purge.service';

const NOW = new Date('2026-11-01T00:00:00Z');
const PAST = new Date('2026-10-31T00:00:00Z');
let seq = 0;

async function makeUser(over: Partial<typeof users.$inferInsert> = {}) {
  seq++;
  const [u] = await db.insert(users).values({ email: `purge-test-${Date.now()}-${seq}@example.com`, name: 'purge-test', ...over }).returning();
  return u;
}

async function makeScheduledOrg(owner: string, scheduledFor: Date = PAST) {
  seq++;
  const [o] = await db
    .insert(organizations)
    .values({
      name: `purge-test-${seq}`,
      slug: `purge-test-${Date.now()}-${seq}`,
      stripeCustomerId: `cus_purge_${seq}`,
      deletionRequestedAt: new Date(scheduledFor.getTime() - 30 * 86_400_000),
      deletionScheduledFor: scheduledFor,
      deletionRequestedBy: owner,
    })
    .returning();
  await db.insert(organizationMembers).values({ organizationId: o.id, userId: owner, role: 'owner' });
  return o;
}

async function fill(orgId: string) {
  const [managed] = await db
    .insert(servers)
    .values({ organizationId: orgId, name: 'm', provider: 'hetzner', region: 'fsn1', isManaged: true, status: 'stopped', providerId: '9001', sshKeyId: '77' })
    .returning();
  const [byos] = await db
    .insert(servers)
    .values({ organizationId: orgId, name: 'b', provider: 'self_hosted', region: 'custom', isManaged: false, status: 'running' })
    .returning();
  const [runner] = await db.insert(projects).values({ organizationId: orgId, name: 'r', slug: `r-${seq}`, status: 'paused' }).returning();
  await db.insert(projects).values({ organizationId: orgId, name: 'gone', slug: `g-${seq}`, status: 'deleted' });
  await db.insert(projects).values({ organizationId: orgId, name: 'mine', slug: `b-${seq}`, serverId: byos.id });
  await db.insert(domains).values({ projectId: runner.id, domain: `r-${Date.now()}-${seq}.pushify.dev`, isAutoGenerated: true });
  await db.insert(purchasedDomains).values({
    organizationId: orgId,
    domainName: `purge-${Date.now()}-${seq}.dev`,
    purchasePriceCents: 1500,
    wholesalePriceCents: 1000,
    expiresAt: new Date('2027-10-01T00:00:00Z'),
  });
  await db.insert(infraWalletTransactions).values({ organizationId: orgId, type: 'credit_topup', amountCents: 2000, balanceAfterCents: 2000 });
  return { managed, runner };
}

const orgRow = async (id: string) => (await db.select().from(organizations).where(eq(organizations.id, id)))[0];
const steps = (id: string) => db.select().from(deletionPurgeSteps).where(eq(deletionPurgeSteps.subjectId, id));

describe.skipIf(!TEST_URL)('deletion purge (real Postgres)', () => {
  const cleanup = async () => {
    await db.execute(sql`delete from organizations where name like 'purge-test-%'`);
    await db.execute(sql`delete from deleted_organizations where name like 'purge-test-%'`);
    await db.execute(sql`delete from users where email like 'purge-test-%'`);
  };
  beforeAll(cleanup);
  afterAll(async () => {
    await cleanup();
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });
  beforeEach(async () => {
    for (const fn of Object.values(h)) fn.mockReset();
    for (const fn of [h.deleteSnapshot, h.deleteServer, h.deleteSSHKey, h.cleanupProject, h.dnsDelete, h.offsitePurge, h.customerDel, h.deleteForward]) {
      fn.mockResolvedValue(undefined);
    }
    h.listSnapshots.mockResolvedValue(['s1', 's2']);
    h.forwards.mockResolvedValue([{ emailBox: 'info', emailTo: 'me@example.com' }]);
    // Only this test's subjects should be due.
    await db.execute(sql`update organizations set deletion_scheduled_for = null where name like 'purge-test-%'`);
    await db.execute(sql`update users set deletion_scheduled_for = null where email like 'purge-test-%'`);
  });

  it('removes everything outside the database first, keeps the billing facts, then deletes the row', async () => {
    const owner = await makeUser();
    const o = await makeScheduledOrg(owner.id);
    const f = await fill(o.id);

    const stats = await deletionPurgeService.sweep(NOW);
    expect(stats).toMatchObject({ organizations: 1, pending: 0 });

    expect(h.listSnapshots).toHaveBeenCalledWith('9001');
    expect(h.deleteSnapshot.mock.calls.map((c) => c[0])).toEqual(['s1', 's2']);
    expect(h.deleteServer).toHaveBeenCalledWith('9001');
    expect(h.deleteSSHKey).toHaveBeenCalledWith('77');
    // Only the live runner project: not the deleted one, not the one on the customer's server.
    expect(h.cleanupProject).toHaveBeenCalledTimes(1);
    expect(h.cleanupProject.mock.calls[0][0].id).toBe(f.runner.id);
    expect(h.dnsDelete).toHaveBeenCalledTimes(1);
    expect(h.offsitePurge).toHaveBeenCalledWith(o.id);
    expect(h.deleteForward).toHaveBeenCalledWith(expect.stringMatching(/^purge-/), 'info');
    expect(h.customerDel).toHaveBeenCalledWith(o.stripeCustomerId);

    expect(await orgRow(o.id)).toBeUndefined();
    expect(await db.select().from(projects).where(eq(projects.organizationId, o.id))).toHaveLength(0);
    expect(await db.select().from(servers).where(eq(servers.organizationId, o.id))).toHaveLength(0);
    const [kept] = await db.select().from(deletedOrganizations).where(eq(deletedOrganizations.id, o.id));
    expect(kept.name).toBe(o.name);
    expect(kept.walletLedger).toHaveLength(1);
    expect(kept.retainUntil.getUTCFullYear() - kept.purgedAt.getUTCFullYear()).toBe(10);
    expect(await steps(o.id)).toHaveLength(0);
    expect(h.completedEmail).toHaveBeenCalledTimes(1);
  });

  it('stops at a failed required step and resumes after it without redoing the rest', async () => {
    const owner = await makeUser();
    const o = await makeScheduledOrg(owner.id);
    await fill(o.id);
    h.offsitePurge.mockRejectedValueOnce(new Error('rclone: 503'));

    expect(await deletionPurgeService.sweep(NOW)).toMatchObject({ organizations: 0, pending: 1 });
    expect(await orgRow(o.id)).toBeDefined();
    const recorded = Object.fromEntries((await steps(o.id)).map((s) => [s.step, s.status]));
    expect(recorded).toMatchObject({ 'managed-servers': 'done', 'runner-projects': 'done', 'offsite-backups': 'failed' });
    expect(h.customerDel).not.toHaveBeenCalled();

    expect(await deletionPurgeService.sweep(NOW)).toMatchObject({ organizations: 1 });
    expect(h.deleteServer).toHaveBeenCalledTimes(1); // not again
    expect(h.offsitePurge).toHaveBeenCalledTimes(2);
    expect(await orgRow(o.id)).toBeUndefined();
  });

  it('tells the admin when a required step keeps failing', async () => {
    const owner = await makeUser();
    const o = await makeScheduledOrg(owner.id);
    h.customerDel.mockRejectedValue(new Error('stripe down'));
    for (let i = 0; i < 3; i++) await deletionPurgeService.sweep(NOW);
    expect(h.adminNotify).toHaveBeenCalledWith('deletion.purge_stuck', expect.objectContaining({ step: 'stripe' }));
    expect(await orgRow(o.id)).toBeDefined();
  });

  it('does not let a best-effort step hold the purge', async () => {
    const owner = await makeUser();
    const o = await makeScheduledOrg(owner.id);
    await fill(o.id);
    h.forwards.mockRejectedValue(new Error('registrar 500'));
    expect(await deletionPurgeService.sweep(NOW)).toMatchObject({ organizations: 1 });
    expect(await orgRow(o.id)).toBeUndefined();
  });

  it('sends one reminder in the last week and leaves organizations that are not due', async () => {
    const owner = await makeUser();
    const soon = await makeScheduledOrg(owner.id, new Date('2026-11-05T00:00:00Z'));
    const later = await makeScheduledOrg(owner.id, new Date('2026-11-30T00:00:00Z'));
    await deletionPurgeService.sweep(NOW);
    await deletionPurgeService.sweep(NOW);
    expect(h.reminderEmail).toHaveBeenCalledTimes(1);
    expect(h.reminderEmail.mock.calls[0][1]).toMatchObject({ kind: 'organization', name: soon.name });
    expect(await orgRow(soon.id)).toBeDefined();
    expect(await orgRow(later.id)).toBeDefined();
    expect(h.deleteServer).not.toHaveBeenCalled();
  });

  it('purges an account after its organization, with its sign-in history, and keeps what it did elsewhere', async () => {
    const u = await makeUser({ deletionRequestedAt: new Date('2026-10-01T00:00:00Z'), deletionScheduledFor: PAST });
    const own = await makeScheduledOrg(u.id);
    // A member of someone else's organization, who invited a colleague there.
    const otherOwner = await makeUser();
    seq++;
    const [other] = await db.insert(organizations).values({ name: `purge-test-${seq}`, slug: `purge-other-${Date.now()}-${seq}` }).returning();
    await db.insert(organizationMembers).values({ organizationId: other.id, userId: otherOwner.id, role: 'owner' });
    await db.insert(organizationMembers).values({ organizationId: other.id, userId: u.id, role: 'admin' });
    const colleague = await makeUser();
    await db.insert(organizationMembers).values({ organizationId: other.id, userId: colleague.id, role: 'member', invitedBy: u.id });
    await db.insert(authEvents).values({ userId: u.id, event: 'login', method: 'password', ipAddress: '198.51.100.7' });

    const stats = await deletionPurgeService.sweep(NOW);
    expect(stats).toMatchObject({ organizations: 1, accounts: 1 });
    expect(await orgRow(own.id)).toBeUndefined();
    expect((await db.select().from(users).where(eq(users.id, u.id)))).toHaveLength(0);
    expect(await db.select().from(authEvents).where(eq(authEvents.ipAddress, '198.51.100.7'))).toHaveLength(0);
    expect(await orgRow(other.id)).toBeDefined();
    const [c] = await db.select().from(organizationMembers).where(eq(organizationMembers.userId, colleague.id));
    expect(c.invitedBy).toBeNull();
    expect(h.completedEmail.mock.calls.map((call) => call[1].kind).sort()).toEqual(['account', 'organization']);
  });
});
