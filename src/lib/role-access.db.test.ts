import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

/**
 * Who may do what, per role, against a real Postgres (ACCOUNT_DELETION_TEST_DATABASE_URL, a
 * disposable database with migrations applied). One organization with an owner, an admin, a
 * member, a viewer and a member restricted to other projects; each sensitive or destructive call
 * is made by every role.
 *
 * "denied" means 403 (or 404 for a project outside a restricted member's list). "allowed" means
 * anything but that: inputs are chosen so an allowed call stops at validation or a missing record
 * before it would touch SSH, a provider or a deploy queue.
 */
const TEST_URL = process.env.ACCOUNT_DELETION_TEST_DATABASE_URL;

vi.mock('../db', async () => {
  const pg = (await import('pg')).default;
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const schema = await import('../db/schema');
  const pool = new pg.Pool({ connectionString: process.env.ACCOUNT_DELETION_TEST_DATABASE_URL || 'postgresql:///nonexistent', max: 4 });
  return { db: drizzle(pool, { schema }), __pool: pool, closeDatabasePool: async () => pool.end() };
});
vi.mock('../lib/redis-client', () => ({ getOptionalRedis: () => null, closeOptionalRedis: async () => {} }));
vi.mock('../utils/ssh', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/ssh')>();
  class NoSsh {
    async connect() {
      throw new Error('no SSH in tests');
    }
    async exec() {
      throw new Error('no SSH in tests');
    }
    disconnect() {}
  }
  return {
    ...actual,
    SSHClient: NoSsh,
    getSSHConnection: async () => {
      throw new Error('no SSH in tests');
    },
    removeSSHConnection: () => {},
  };
});
vi.mock('../providers', () => ({
  createProvider: () =>
    new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error('no provider in tests');
        },
      },
    ),
}));

import { sql } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { apiKeys, databases, environmentVariables, memberProjectAccess, organizationMembers, organizations, projects, servers, users } from '../db/schema';
import { encrypt } from './encryption';
import { t } from '../i18n';
import { generateAccessToken } from './jwt';
import { apiKeyService } from '../services/apikey.service';
import { databaseService } from '../services/database.service';
import { databaseBackupService } from '../services/database-backup.service';
import { deploymentService } from '../services/deployment.service';
import { envVarService } from '../services/envvar.service';
import { healthCheckService } from '../services/healthcheck.service';
import { notificationService } from '../services/notification.service';
import { organizationService } from '../services/organization.service';
import { projectService } from '../services/project.service';
import { projectVolumeService } from '../services/project-volume.service';
import { scheduledTaskService } from '../services/scheduled-task.service';
import { serverService } from '../services/server.service';

type Role = 'owner' | 'admin' | 'member' | 'viewer' | 'restricted';
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer', 'restricted'];

const ctx = {} as {
  orgId: string;
  projectId: string;
  otherProjectId: string;
  serverId: string;
  databaseId: string;
  users: Record<Role, string>;
};

const ROLE_REFUSALS = new Set([t('en', 'errors', 'forbidden'), t('en', 'organizations', 'noAccess'), t('en', 'organizations', 'adminRequired')]);

async function outcome(fn: () => Promise<unknown>): Promise<'allowed' | 'denied'> {
  try {
    await fn();
    return 'allowed';
  } catch (err) {
    // Only a refusal for the role counts: a plan limit or a locked organization is also a 403.
    if (err instanceof HTTPException && err.status === 403 && ROLE_REFUSALS.has(err.message)) return 'denied';
    return 'allowed';
  }
}

/** Runs `call` as every role; returns { role: outcome }. */
async function matrix(call: (userId: string) => Promise<unknown>) {
  const out = {} as Record<Role, 'allowed' | 'denied'>;
  for (const role of ROLES) out[role] = await outcome(() => call(ctx.users[role]));
  return out;
}

const ALL_BUT_VIEWER = { owner: 'allowed', admin: 'allowed', member: 'allowed', viewer: 'denied' } as const;
const ADMINS = { owner: 'allowed', admin: 'allowed', member: 'denied', viewer: 'denied', restricted: 'denied' } as const;

describe.skipIf(!TEST_URL)('role access (real Postgres)', () => {
  const cleanup = async () => {
    await db.execute(sql`delete from organizations where name like 'role-test-%'`);
    await db.execute(sql`delete from users where email like 'role-test-%'`);
  };

  beforeAll(async () => {
    await cleanup();
    const stamp = Date.now();
    const [org] = await db.insert(organizations).values({ name: `role-test-${stamp}`, slug: `role-test-${stamp}`, billingEmail: 'billing@example.com' }).returning();
    ctx.orgId = org.id;
    ctx.users = {} as Record<Role, string>;
    for (const role of ROLES) {
      const [u] = await db.insert(users).values({ email: `role-test-${role}-${stamp}@example.com`, name: role }).returning();
      ctx.users[role] = u.id;
      await db.insert(organizationMembers).values({
        organizationId: org.id,
        userId: u.id,
        role: role === 'restricted' ? 'member' : role,
        restrictedAccess: role === 'restricted',
      });
    }
    const [p] = await db.insert(projects).values({ organizationId: org.id, name: 'app', slug: `role-app-${stamp}` }).returning();
    const [other] = await db.insert(projects).values({ organizationId: org.id, name: 'other', slug: `role-other-${stamp}` }).returning();
    ctx.projectId = p.id;
    ctx.otherProjectId = other.id;
    // The restricted member may only see `other`.
    await db.insert(memberProjectAccess).values({ organizationId: org.id, userId: ctx.users.restricted, projectId: other.id });
    const [s] = await db
      .insert(servers)
      .values({ organizationId: org.id, name: 'srv', provider: 'hetzner', region: 'fsn1', isManaged: true, providerId: '1', status: 'running' })
      .returning();
    ctx.serverId = s.id;
    const [d] = await db
      .insert(databases)
      .values({
        organizationId: org.id,
        serverId: s.id,
        name: 'db',
        type: 'postgresql',
        version: '16',
        databaseName: `db_${stamp}`,
        username: 'u',
        password: encrypt('secret-password'),
        containerName: `pushify-db-${stamp}`,
        port: 5432,
      } as typeof databases.$inferInsert)
      .returning();
    ctx.databaseId = d.id;
    await db.insert(environmentVariables).values([
      { projectId: p.id, key: 'PUBLIC_URL', valueEncrypted: encrypt('https://example.com'), isSecret: false, environment: 'production' },
      { projectId: p.id, key: 'STRIPE_KEY', valueEncrypted: encrypt('sk_live_abcdefgh'), isSecret: true, environment: 'production' },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    const { __pool } = (await import('../db')) as unknown as { __pool: { end(): Promise<void> } };
    await __pool.end();
  });

  it('database credentials and backup downloads: owners and admins only', async () => {
    expect(await matrix((u) => databaseService.getConnectionDetails(ctx.databaseId, ctx.orgId, u, 'en'))).toEqual(ADMINS);
    expect(await matrix((u) => databaseBackupService.downloadBackup(ctx.databaseId, '00000000-0000-0000-0000-000000000000', ctx.orgId, u, 'en'))).toEqual(ADMINS);
  });

  it('scheduled tasks (commands in the container): viewers see, members and up change and run', async () => {
    const list = await matrix((u) => scheduledTaskService.listTasks(ctx.projectId, ctx.orgId, u, 'en'));
    expect(list).toMatchObject({ owner: 'allowed', admin: 'allowed', member: 'allowed', viewer: 'allowed' });
    const create = await matrix((u) => scheduledTaskService.createTask(ctx.projectId, ctx.orgId, u, { name: '' }, 'en'));
    expect(create).toMatchObject(ALL_BUT_VIEWER);
    expect(await matrix((u) => scheduledTaskService.authorizeRun(ctx.projectId, ctx.orgId, u, 'en'))).toMatchObject(ALL_BUT_VIEWER);
  });

  it('deploying, cancelling and rolling back: member and up', async () => {
    const bogus = '00000000-0000-0000-0000-000000000000';
    expect(await matrix((u) => deploymentService.cancel(bogus, ctx.projectId, ctx.orgId, u, 'en'))).toMatchObject(ALL_BUT_VIEWER);
    expect(await matrix((u) => deploymentService.rollback(bogus, ctx.projectId, ctx.orgId, u, 'en'))).toMatchObject(ALL_BUT_VIEWER);
  });

  it('creating a project, pausing it and rotating its webhook secret: member and up', async () => {
    expect(await matrix((u) => projectService.create(ctx.orgId, u, { name: '' } as never, 'en'))).toMatchObject(ALL_BUT_VIEWER);
    expect(await matrix((u) => projectService.regenerateWebhookSecret(ctx.projectId, ctx.orgId, u, 'en'))).toMatchObject(ALL_BUT_VIEWER);
  });

  it('server power: admins and owners; refreshing its status: member and up', async () => {
    expect(await matrix((u) => serverService.powerAction(ctx.serverId, ctx.orgId, u, 'reboot', 'en'))).toEqual(ADMINS);
    expect(await matrix((u) => serverService.syncServer(ctx.serverId, ctx.orgId, u, 'en'))).toMatchObject(ALL_BUT_VIEWER);
  });

  it('notifications, health checks and volumes: viewers read, members and up change', async () => {
    expect(await matrix((u) => notificationService.getChannels(ctx.projectId, ctx.orgId, u, 'en'))).toMatchObject({ viewer: 'allowed' });
    expect(await matrix((u) => notificationService.createChannel(ctx.projectId, ctx.orgId, u, { type: 'nope' } as never, 'en'))).toMatchObject(ALL_BUT_VIEWER);
    expect(await matrix((u) => healthCheckService.upsertConfig(ctx.projectId, ctx.orgId, u, { endpoint: 'not a path' } as never, 'en'))).toMatchObject(ALL_BUT_VIEWER);
    expect(await matrix((u) => projectVolumeService.createVolume(ctx.projectId, ctx.orgId, u, {}, 'en'))).toMatchObject(ALL_BUT_VIEWER);
  });

  it('a restricted member cannot reach a project outside their list, even to read', async () => {
    await expect(notificationService.getChannels(ctx.projectId, ctx.orgId, ctx.users.restricted, 'en')).rejects.toMatchObject({ status: 404 });
    await expect(notificationService.getChannels(ctx.otherProjectId, ctx.orgId, ctx.users.restricted, 'en')).resolves.toBeDefined();
  });

  it('environment variables: viewers see names only', async () => {
    const asViewer = await envVarService.getByProject(ctx.projectId, ctx.orgId, ctx.users.viewer, undefined, 'en');
    expect(asViewer.map((v) => v.value)).toEqual(['****', '****']);
    const asMember = await envVarService.getByProject(ctx.projectId, ctx.orgId, ctx.users.member, undefined, 'en');
    const byKey = Object.fromEntries(asMember.map((v) => [v.key, v.value]));
    expect(byKey).toEqual({ PUBLIC_URL: 'https://example.com', STRIPE_KEY: 'sk****gh' });
  });

  describe('routes', () => {
    const call = async (role: Role, method: string, path: string, body?: unknown, key?: string) => {
      const { app } = await import('../app');
      const token = key ?? (await generateAccessToken(ctx.users[role], ctx.orgId));
      return app.request(path, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    };
    const statuses = async (method: string, path: string, body?: unknown) => {
      const out = {} as Record<Role, number>;
      for (const role of ROLES) out[role] = (await call(role, method, path, body)).status;
      return out;
    };

    it('buying domains and taking the transfer code: admins and owners', async () => {
      const buy = await statuses('POST', '/api/v1/domains/purchase', {});
      expect(buy.viewer).toBe(403);
      expect(buy.member).toBe(403);
      expect(buy.admin).not.toBe(403);
      const code = await statuses('POST', '/api/v1/domains/example.com/auth-code');
      expect(code.member).toBe(403);
      expect(code.owner).not.toBe(403);
    });

    it('activity log and invoices: admins and owners', async () => {
      const activity = await statuses('GET', '/api/v1/activity');
      expect([activity.viewer, activity.member]).toEqual([403, 403]);
      expect(activity.admin).toBe(200);
      const invoices = await statuses('GET', '/api/v1/billing/invoices');
      expect([invoices.viewer, invoices.member]).toEqual([403, 403]);
      expect(invoices.owner).not.toBe(403);
    });

    it('the billing address is hidden from non-admins', async () => {
      const asMember = await (await call('member', 'GET', '/api/v1/billing')).json();
      const asAdmin = await (await call('admin', 'GET', '/api/v1/billing')).json();
      expect(asMember.data.billingEmail).toBeNull();
      expect(asAdmin.data.billingEmail).toBe('billing@example.com');
    });

    it('an API key cannot manage keys, and a removed member\'s keys stop working', async () => {
      const created = await apiKeyService.create(ctx.users.member, ctx.orgId, { name: 'ci', scopes: ['*'] } as never);
      const key = (created as { secretKey: string }).secretKey;
      expect((await call('member', 'GET', '/api/v1/api-keys', undefined, key)).status).toBe(403);
      expect((await call('member', 'GET', `/api/v1/projects/${ctx.projectId}`, undefined, key)).status).toBe(200);

      // A second member, removed: their key is revoked with them.
      const stamp = Date.now();
      const [u] = await db.insert(users).values({ email: `role-test-leaver-${stamp}@example.com`, name: 'leaver' }).returning();
      await db.insert(organizationMembers).values({ organizationId: ctx.orgId, userId: u.id, role: 'member' });
      const leaverKey = ((await apiKeyService.create(u.id, ctx.orgId, { name: 'x', scopes: ['*'] } as never)) as { secretKey: string }).secretKey;
      expect(await apiKeyService.validate(leaverKey)).not.toBeNull();
      await organizationService.removeMember(ctx.orgId, ctx.users.owner, u.id, 'en');
      expect(await apiKeyService.validate(leaverKey)).toBeNull();
      expect(await db.select().from(apiKeys).where(sql`${apiKeys.userId} = ${u.id}`)).toHaveLength(0);
    });
  });
});
