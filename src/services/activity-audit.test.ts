import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What actually gets written to activity_logs for the audit helpers added for the team audit log. */

const inserted: Array<Record<string, unknown>> = [];
vi.mock('../db', () => ({
  db: {
    insert: () => ({ values: async (v: Record<string, unknown>) => { inserted.push(v); } }),
  },
}));

const { activityService } = await import('./activity.service');
const { runWithAuditApiKey } = await import('../lib/audit');

beforeEach(() => {
  inserted.length = 0;
});

describe('activity service audit helpers', () => {
  it('envvar.updated stores the key and a diff with the value as changed only', async () => {
    await activityService.logEnvVarUpdated(
      'org-A', 'user-1', 'p-1', 'STRIPE_KEY',
      { valueChanged: true, isSecret: { from: false, to: true } },
      undefined, undefined, 'api'
    );
    expect(inserted[0]).toMatchObject({
      organizationId: 'org-A',
      userId: 'user-1',
      projectId: 'p-1',
      action: 'envvar.updated',
      source: 'api',
      metadata: { key: 'STRIPE_KEY', changed: ['value', 'isSecret'] },
      changes: { value: { changed: true }, isSecret: { from: false, to: true } },
    });
    expect(Object.keys(inserted[0].metadata as object).sort()).toEqual(['changed', 'key']);
  });

  it('an API key request records the key id and name (never the secret) on the entry', async () => {
    await runWithAuditApiKey(
      { id: 'key-1', name: 'CI deploy', keyHash: 'HASH_SHOULD_NOT_LEAK' } as never,
      () => activityService.logEnvVarUpdated('org-A', 'user-1', 'p-1', 'DB_URL', { valueChanged: true }, undefined, undefined, 'api')
    );
    expect(inserted[0]).toMatchObject({
      action: 'envvar.updated',
      source: 'api',
      metadata: { key: 'DB_URL', apiKey: { id: 'key-1', name: 'CI deploy' } },
    });
    expect(JSON.stringify(inserted[0])).not.toContain('HASH_SHOULD_NOT_LEAK');
  });

  it('the API key is only attached to api-sourced entries', async () => {
    await runWithAuditApiKey({ id: 'key-1', name: 'CI deploy' }, () =>
      activityService.logEnvVarDeleted('org-A', 'user-1', 'p-1', 'K', undefined, undefined, 'ui')
    );
    expect(inserted[0].metadata).not.toHaveProperty('apiKey');
  });

  it('envvar.updated leaves an unchanged secret flag out of the diff', async () => {
    await activityService.logEnvVarUpdated('org-A', 'user-1', 'p-1', 'K', {
      valueChanged: true,
      isSecret: { from: true, to: true },
    });
    expect(inserted[0].changes).toEqual({ value: { changed: true } });
  });

  it('project.updated stores the field diff in changes', async () => {
    await activityService.logProjectUpdated(
      'org-A', 'user-1', 'p-1', 'web',
      { gitBranch: { from: 'main', to: 'prod' } },
      undefined, undefined, 'ui'
    );
    expect(inserted[0]).toMatchObject({
      action: 'project.updated',
      source: 'ui',
      description: 'Updated project "web" (gitBranch)',
      metadata: { projectName: 'web', fields: ['gitBranch'] },
      changes: { gitBranch: { from: 'main', to: 'prod' } },
    });
  });

  it('settings.updated stores the settings diff', async () => {
    await activityService.logSettingsUpdated(
      'org-A', 'user-1', 'p-1', 'forceHttps', undefined, undefined, 'ui',
      { forceHttps: { from: false, to: true } }
    );
    expect(inserted[0]).toMatchObject({
      action: 'settings.updated',
      source: 'ui',
      changes: { forceHttps: { from: false, to: true } },
    });
  });

  it('log() redacts sensitive keys in changes even if a caller passes them in clear', async () => {
    await activityService.log({
      organizationId: 'org-A',
      userId: 'user-1',
      action: 'settings.updated',
      description: 'x',
      changes: { webhookSecret: { from: 'old-secret-1', to: 'new-secret-2' } },
    });
    const text = JSON.stringify(inserted[0]);
    expect(text).not.toContain('old-secret-1');
    expect(text).not.toContain('new-secret-2');
  });

  it('source defaults to system when there is no acting user, unknown (null) otherwise', async () => {
    await activityService.logDeploymentSucceeded('org-A', 'p-1', 'dep-1');
    await activityService.log({ organizationId: 'org-A', userId: 'user-1', action: 'project.created', description: 'x' });
    expect(inserted[0].source).toBe('system');
    expect(inserted[1].source).toBeNull();
    expect(inserted[1].changes).toBeNull();
  });

  it('member.invited records the target user, email and role', async () => {
    await activityService.logMemberAdded('org-A', 'user-1', 'user-2', 'new@example.com', 'member');
    expect(inserted[0]).toMatchObject({
      organizationId: 'org-A',
      userId: 'user-1',
      action: 'member.invited',
      metadata: { targetUserId: 'user-2', email: 'new@example.com', role: 'member' },
    });
  });

  it('member.role_changed records the role diff', async () => {
    await activityService.logMemberRoleChanged('org-A', 'user-1', 'user-2', 'member', 'admin');
    expect(inserted[0]).toMatchObject({
      action: 'member.role_changed',
      metadata: { targetUserId: 'user-2', changes: { role: { from: 'member', to: 'admin' } } },
      changes: { role: { from: 'member', to: 'admin' } },
    });
  });

  it('SSO connection saved records the configuration but never the client secret', async () => {
    await activityService.logSsoConnectionSaved(
      'org-A',
      'user-1',
      {
        issuer: 'https://idp.example.com/realms/acme',
        clientId: 'pushify',
        emailDomains: ['acme.com'],
        enforced: false,
        defaultRole: 'member',
        // Extra fields on the input must not leak into the log
        ...({ clientSecret: 'super-secret' } as object),
      } as never,
      true
    );
    expect(inserted[0]).toMatchObject({
      organizationId: 'org-A',
      userId: 'user-1',
      action: 'settings.updated',
      metadata: {
        setting: 'sso',
        operation: 'saved',
        issuer: 'https://idp.example.com/realms/acme',
        clientId: 'pushify',
        emailDomains: ['acme.com'],
        enforced: false,
        defaultRole: 'member',
        clientSecretChanged: true,
      },
    });
    expect(JSON.stringify(inserted[0])).not.toContain('super-secret');
  });

  it('SSO connection removed is recorded', async () => {
    await activityService.logSsoConnectionRemoved('org-A', 'user-1');
    expect(inserted[0]).toMatchObject({
      action: 'settings.updated',
      metadata: { setting: 'sso', operation: 'removed' },
    });
  });

  it('registry credential saved records host, name and username but never the token', async () => {
    await activityService.logRegistryCredentialSaved(
      'org-A',
      'user-1',
      {
        id: 'rc-1',
        name: 'GHCR',
        registry: 'ghcr.io',
        username: 'octocat',
        // Extra fields on the input must not leak into the log
        ...({ password: 'ghp_SHOULD_NOT_LEAK', passwordEncrypted: 'ENC_SHOULD_NOT_LEAK' } as object),
      } as never,
      undefined,
      undefined,
      'ui'
    );
    expect(inserted[0]).toMatchObject({
      organizationId: 'org-A',
      userId: 'user-1',
      action: 'settings.updated',
      source: 'ui',
      metadata: {
        setting: 'registry',
        operation: 'saved',
        credentialId: 'rc-1',
        name: 'GHCR',
        registry: 'ghcr.io',
        username: 'octocat',
      },
    });
    const serialized = JSON.stringify(inserted[0]);
    expect(serialized).not.toContain('ghp_SHOULD_NOT_LEAK');
    expect(serialized).not.toContain('ENC_SHOULD_NOT_LEAK');
  });

  it('registry credential removed is recorded', async () => {
    await activityService.logRegistryCredentialRemoved('org-A', 'user-1', {
      id: 'rc-1',
      name: 'Docker Hub',
      registry: 'docker.io',
    });
    expect(inserted[0]).toMatchObject({
      action: 'settings.updated',
      description: 'Removed registry credential "Docker Hub" (docker.io)',
      metadata: { setting: 'registry', operation: 'removed', credentialId: 'rc-1', registry: 'docker.io' },
    });
  });

  it('member.removed records the target user and the role they had', async () => {
    await activityService.logMemberRemoved('org-A', 'user-1', 'user-2', 'viewer');
    expect(inserted[0]).toMatchObject({
      action: 'member.removed',
      metadata: { targetUserId: 'user-2', role: 'viewer' },
    });
  });
});
