import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono, type Context } from 'hono';

/**
 * Locked (admin-only) environment variables: owners and admins read and change the value; a member
 * gets it withheld (`****`, `masked: true`) and a 403 on any change; a viewer gets every value
 * withheld, as before. An API key needs envvars:read / envvars:write and then acts with the role of
 * the user who created it.
 *
 * The real auth middleware, scope check, route and service run; key validation, the JWT check,
 * membership, the repositories and the audit log are mocked.
 */
const { h } = vi.hoisted(() => ({
  h: {
    rows: [] as Array<Record<string, unknown>>,
    roles: {} as Record<string, string>,
    audit: [] as Array<{ method: string; args: unknown[] }>,
  },
}));

const KEYS: Record<string, { userId: string; scopes: string }> = {
  pk_live_member_projects_read: { userId: 'u-member', scopes: 'projects:read' },
  pk_live_member_env_read: { userId: 'u-member', scopes: 'envvars:read' },
  pk_live_member_env_rw: { userId: 'u-member', scopes: 'envvars:read,envvars:write' },
  pk_live_owner_env_read: { userId: 'u-owner', scopes: 'envvars:read' },
};

vi.mock('../db', () => ({ db: {} }));
vi.mock('../services/apikey.service', () => ({
  apiKeyService: {
    validate: vi.fn(async (token: string) =>
      KEYS[token]
        ? { userId: KEYS[token].userId, organizationId: 'org-1', apiKey: { id: 'key-1', name: 'k', scopes: KEYS[token].scopes } }
        : null
    ),
  },
  hasScope: (keyScopes: string, required: string) => keyScopes === '*' || keyScopes.split(',').includes(required),
}));
vi.mock('../lib/jwt', () => ({
  // `session-<role>` is a signed-in user with that role
  verifyToken: async (token: string) => ({ type: 'access', sub: `u-${token.replace('session-', '')}`, org: 'org-1' }),
}));
vi.mock('../lib/user-ban', () => ({ isUserBanned: async () => false, accountSuspendedError: () => new Error('banned') }));
vi.mock('../lib/deletion-lock', () => ({
  isAllowedWhilePendingDeletion: () => true,
  isOrganizationPendingDeletion: async () => false,
}));
vi.mock('../middleware/rate-limit', () => ({
  applyPlanApiRateLimit: async (_c: unknown, next: () => Promise<void>) => next(),
}));
vi.mock('../lib/member-project-scope', () => ({ assertMemberProjectScope: async () => {} }));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: {
    findMember: async (_orgId: string, userId: string) => (h.roles[userId] ? { role: h.roles[userId], restrictedAccess: false } : null),
  },
}));
vi.mock('../repositories/project.repository', () => ({
  projectRepository: { findById: async (id: string) => ({ id, organizationId: 'org-1', status: 'active' }) },
}));
vi.mock('../repositories/envvar.repository', () => {
  const now = new Date(0);
  return {
    envVarRepository: {
      findById: vi.fn(async (id: string) => h.rows.find((r) => r.id === id) ?? null),
      findByProject: vi.fn(async (projectId: string, environment?: string) =>
        h.rows.filter((r) => r.projectId === projectId && (!environment || r.environment === environment))
      ),
      findByKey: vi.fn(
        async (projectId: string, environment: string, key: string) =>
          h.rows.find((r) => r.projectId === projectId && r.environment === environment && r.key === key) ?? null
      ),
      create: vi.fn(async (input: Record<string, unknown>) => {
        const row = { id: `ev-${h.rows.length + 1}`, isSecret: false, locked: false, createdAt: now, updatedAt: now, ...input };
        row.isSecret ??= false;
        row.locked ??= false;
        h.rows.push(row);
        return row;
      }),
      update: vi.fn(async (id: string, input: Record<string, unknown>) => {
        const row = h.rows.find((r) => r.id === id);
        if (row) Object.assign(row, input);
        return row ?? null;
      }),
      delete: vi.fn(async (id: string) => {
        h.rows = h.rows.filter((r) => r.id !== id);
      }),
    },
  };
});
vi.mock('../services/activity.service', () => {
  const record = (method: string) => async (...args: unknown[]) => {
    h.audit.push({ method, args });
  };
  return {
    activityService: {
      logEnvVarCreated: record('logEnvVarCreated'),
      logEnvVarUpdated: record('logEnvVarUpdated'),
      logEnvVarDeleted: record('logEnvVarDeleted'),
    },
  };
});

import { errorHandler } from '../middleware/error-handler';
import { encrypt, decrypt } from '../lib/encryption';
import { t } from '../i18n';
import { envVarRepository } from '../repositories/envvar.repository';
import { envVarRoutes } from './envvars';

const P = '00000000-0000-4000-8000-000000000001';
const ID = {
  PUBLIC_URL: '00000000-0000-4000-8000-0000000000a1',
  STRIPE_KEY: '00000000-0000-4000-8000-0000000000a2',
  ROOT_DB_URL: '00000000-0000-4000-8000-0000000000a3',
};
const LOCKED_VALUE = 'postgres://root:hunter2-0123456789@db.internal/prod';

const app = new Hono();
app.route('/api/v1/projects/:projectId/env', envVarRoutes);
app.onError((err, c) => errorHandler(err, c as Context));

type EnvVarBody = { key: string; value: string; isSecret: boolean; locked: boolean; masked: boolean };

const request = (token: string, method: string, path = '', body?: unknown) =>
  app.request(`/api/v1/projects/${P}/env${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function list(token: string) {
  const res = await request(token, 'GET');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { data: EnvVarBody[] };
  return Object.fromEntries(body.data.map((v) => [v.key, v]));
}

async function errorMessage(res: Response) {
  return ((await res.json()) as { error: { message: string } }).error.message;
}

const row = (key: keyof typeof ID) => h.rows.find((r) => r.id === ID[key])!;
const valueOf = (key: keyof typeof ID) => decrypt(row(key).valueEncrypted as string);
const ADMIN_REQUIRED = t('en', 'organizations', 'adminRequired');

beforeEach(() => {
  vi.clearAllMocks();
  h.audit = [];
  h.roles = { 'u-owner': 'owner', 'u-admin': 'admin', 'u-member': 'member', 'u-viewer': 'viewer' };
  const now = new Date(0);
  const base = { projectId: P, environment: 'production', createdAt: now, updatedAt: now };
  h.rows = [
    { ...base, id: ID.PUBLIC_URL, key: 'PUBLIC_URL', valueEncrypted: encrypt('https://example.com'), isSecret: false, locked: false },
    { ...base, id: ID.STRIPE_KEY, key: 'STRIPE_KEY', valueEncrypted: encrypt('sk_live_abcdefgh'), isSecret: true, locked: false },
    { ...base, id: ID.ROOT_DB_URL, key: 'ROOT_DB_URL', valueEncrypted: encrypt(LOCKED_VALUE), isSecret: false, locked: true },
  ];
});

describe('reading a locked variable', () => {
  it.each(['owner', 'admin'])('an %s sees it', async (role) => {
    const vars = await list(`session-${role}`);
    expect(vars.ROOT_DB_URL).toMatchObject({ value: LOCKED_VALUE, locked: true, masked: false });
    expect(vars.STRIPE_KEY).toMatchObject({ value: 'sk****gh', masked: false });
  });

  it('a member gets it withheld, everything else as before', async () => {
    const res = await request('session-member', 'GET');
    const text = await res.text();
    expect(text).not.toContain(LOCKED_VALUE);
    const vars = Object.fromEntries((JSON.parse(text) as { data: EnvVarBody[] }).data.map((v) => [v.key, v]));
    expect(vars.ROOT_DB_URL).toMatchObject({ value: '****', locked: true, masked: true });
    expect(vars.PUBLIC_URL).toMatchObject({ value: 'https://example.com', masked: false });
    expect(vars.STRIPE_KEY).toMatchObject({ value: 'sk****gh', masked: false });

    const single = await request('session-member', 'GET', `/${ID.ROOT_DB_URL}`);
    expect(single.status).toBe(200);
    expect(((await single.json()) as { data: EnvVarBody }).data).toMatchObject({ value: '****', masked: true });
  });

  it('a viewer gets every value withheld', async () => {
    const vars = await list('session-viewer');
    expect(Object.values(vars).map((v) => [v.value, v.masked])).toEqual([
      ['****', true],
      ['****', true],
      ['****', true],
    ]);
  });

  it('an API key without envvars:read is refused before anything is read', async () => {
    const res = await request('pk_live_member_projects_read', 'GET');
    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toBe(t('en', 'apiKeys', 'insufficientScope'));
    expect(envVarRepository.findByProject).not.toHaveBeenCalled();
  });

  it('an envvars:read key acts with the role of the user who created it', async () => {
    expect((await list('pk_live_member_env_read')).ROOT_DB_URL).toMatchObject({ value: '****', masked: true });
    expect((await list('pk_live_owner_env_read')).ROOT_DB_URL).toMatchObject({ value: LOCKED_VALUE, masked: false });
  });
});

describe('changing a locked variable', () => {
  it('a member cannot change, unlock or delete it', async () => {
    for (const [method, path, body] of [
      ['PATCH', `/${ID.ROOT_DB_URL}`, { value: 'postgres://evil' }],
      ['PATCH', `/${ID.ROOT_DB_URL}`, { locked: false }],
      ['PATCH', `/${ID.ROOT_DB_URL}`, { isSecret: true }],
      ['DELETE', `/${ID.ROOT_DB_URL}`, undefined],
    ] as const) {
      const res = await request('session-member', method, path, body);
      expect(res.status).toBe(403);
      expect(await errorMessage(res)).toBe(ADMIN_REQUIRED);
    }
    expect(envVarRepository.update).not.toHaveBeenCalled();
    expect(envVarRepository.delete).not.toHaveBeenCalled();
    expect(valueOf('ROOT_DB_URL')).toBe(LOCKED_VALUE);
    expect(h.audit).toEqual([]);
  });

  it('a member cannot lock a variable or create a locked one, but still edits unlocked ones', async () => {
    const lock = await request('session-member', 'PATCH', `/${ID.PUBLIC_URL}`, { locked: true });
    expect(lock.status).toBe(403);
    const create = await request('session-member', 'POST', '', { key: 'NEW_KEY', value: 'x', locked: true });
    expect(create.status).toBe(403);
    expect(envVarRepository.create).not.toHaveBeenCalled();

    // Sending the current lock state is not a lock change
    const edit = await request('session-member', 'PATCH', `/${ID.PUBLIC_URL}`, { value: 'https://new.example.com', locked: false });
    expect(edit.status).toBe(200);
    expect(valueOf('PUBLIC_URL')).toBe('https://new.example.com');
  });

  it('a viewer is refused as before', async () => {
    const res = await request('session-viewer', 'PATCH', `/${ID.ROOT_DB_URL}`, { value: 'x' });
    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toBe(t('en', 'errors', 'forbidden'));
  });

  it('an envvars:read key cannot write; a member\'s envvars:write key cannot change a locked one', async () => {
    const readOnly = await request('pk_live_member_env_read', 'PATCH', `/${ID.ROOT_DB_URL}`, { value: 'x' });
    expect(readOnly.status).toBe(403);
    expect(await errorMessage(readOnly)).toBe(t('en', 'apiKeys', 'insufficientScope'));

    const write = await request('pk_live_member_env_rw', 'PATCH', `/${ID.ROOT_DB_URL}`, { value: 'x' });
    expect(write.status).toBe(403);
    expect(await errorMessage(write)).toBe(ADMIN_REQUIRED);
    expect(valueOf('ROOT_DB_URL')).toBe(LOCKED_VALUE);
  });

  it.each(['owner', 'admin'])('an %s changes, unlocks and creates locked variables', async (role) => {
    const edit = await request(`session-${role}`, 'PATCH', `/${ID.ROOT_DB_URL}`, { value: 'postgres://new' });
    expect(edit.status).toBe(200);
    expect(((await edit.json()) as { data: EnvVarBody }).data).toMatchObject({ value: 'postgres://new', locked: true, masked: false });

    const unlock = await request(`session-${role}`, 'PATCH', `/${ID.ROOT_DB_URL}`, { locked: false });
    expect(unlock.status).toBe(200);
    expect(row('ROOT_DB_URL').locked).toBe(false);

    const create = await request(`session-${role}`, 'POST', '', { key: 'NEW_KEY', value: 'x', locked: true });
    expect(create.status).toBe(201);
    expect(((await create.json()) as { data: EnvVarBody }).data).toMatchObject({ key: 'NEW_KEY', locked: true });
  });
});

describe('the lock in the audit log', () => {
  it('locking and unlocking are recorded as from -> to, never the value', async () => {
    await request('session-admin', 'PATCH', `/${ID.PUBLIC_URL}`, { locked: true });
    await request('session-owner', 'PATCH', `/${ID.PUBLIC_URL}`, { locked: false });
    const updates = h.audit.filter((a) => a.method === 'logEnvVarUpdated');
    expect(updates.map((u) => u.args.slice(1, 5))).toEqual([
      ['u-admin', P, 'PUBLIC_URL', { valueChanged: false, isSecret: { from: false, to: false }, locked: { from: false, to: true } }],
      ['u-owner', P, 'PUBLIC_URL', { valueChanged: false, isSecret: { from: false, to: false }, locked: { from: true, to: false } }],
    ]);
    expect(JSON.stringify(h.audit)).not.toContain('example.com');
  });
});

describe('bulk upsert (pushify env push)', () => {
  it('a member pushing back the withheld placeholder leaves the locked variable as it is', async () => {
    const res = await request('session-member', 'POST', '/bulk', {
      variables: [
        { key: 'ROOT_DB_URL', value: '****' },
        { key: 'PUBLIC_URL', value: 'https://pushed.example.com' },
      ],
    });
    expect(res.status).toBe(200);
    const results = ((await res.json()) as { data: Array<{ key: string; action: string }> }).data;
    expect(Object.fromEntries(results.map((r) => [r.key, r.action]))).toEqual({ ROOT_DB_URL: 'unchanged', PUBLIC_URL: 'updated' });
    expect(valueOf('ROOT_DB_URL')).toBe(LOCKED_VALUE);
    expect(valueOf('PUBLIC_URL')).toBe('https://pushed.example.com');
  });

  it('a member pushing a new value for a locked variable is refused and nothing is written', async () => {
    const res = await request('session-member', 'POST', '/bulk', {
      variables: [
        { key: 'PUBLIC_URL', value: 'https://pushed.example.com' },
        { key: 'ROOT_DB_URL', value: 'postgres://evil' },
      ],
    });
    expect(res.status).toBe(403);
    expect(await errorMessage(res)).toBe(ADMIN_REQUIRED);
    expect(envVarRepository.update).not.toHaveBeenCalled();
    expect(envVarRepository.create).not.toHaveBeenCalled();
    expect(valueOf('PUBLIC_URL')).toBe('https://example.com');
  });

  it('an admin pushes a new value for a locked variable', async () => {
    const res = await request('session-admin', 'POST', '/bulk', { variables: [{ key: 'ROOT_DB_URL', value: 'postgres://new' }] });
    expect(res.status).toBe(200);
    expect(valueOf('ROOT_DB_URL')).toBe('postgres://new');
    expect(row('ROOT_DB_URL').locked).toBe(true);
  });
});

describe('cloning an environment', () => {
  const clone = (token: string) =>
    request(token, 'POST', '/clone', { sourceEnvironment: 'production', targetEnvironment: 'staging', overwrite: true });

  it('a member\'s clone skips locked variables', async () => {
    const res = await clone('session-member');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: unknown }).data).toEqual({ copied: 2, skipped: 1, overwritten: 0 });
    expect(h.rows.filter((r) => r.environment === 'staging').map((r) => r.key).sort()).toEqual(['PUBLIC_URL', 'STRIPE_KEY']);
  });

  it('a member cannot overwrite a locked variable in the target', async () => {
    h.rows.push({ ...row('PUBLIC_URL'), id: 'staging-1', environment: 'staging', valueEncrypted: encrypt('staging-url'), locked: true });
    const res = await clone('session-member');
    expect(((await res.json()) as { data: unknown }).data).toEqual({ copied: 1, skipped: 2, overwritten: 0 });
    expect(decrypt(h.rows.find((r) => r.id === 'staging-1')!.valueEncrypted as string)).toBe('staging-url');
  });

  it('an admin\'s clone copies locked variables and keeps them locked', async () => {
    const res = await clone('session-admin');
    expect(((await res.json()) as { data: unknown }).data).toEqual({ copied: 3, skipped: 0, overwritten: 0 });
    const copy = h.rows.find((r) => r.environment === 'staging' && r.key === 'ROOT_DB_URL')!;
    expect(copy.locked).toBe(true);
    expect(decrypt(copy.valueEncrypted as string)).toBe(LOCKED_VALUE);
  });
});
