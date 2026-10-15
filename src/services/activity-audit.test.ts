import { describe, it, expect, vi, beforeEach } from 'vitest';

/** What actually gets written to activity_logs for the audit helpers added for the team audit log. */

const inserted: Array<Record<string, unknown>> = [];
vi.mock('../db', () => ({
  db: {
    insert: () => ({ values: async (v: Record<string, unknown>) => { inserted.push(v); } }),
  },
}));

const { activityService } = await import('./activity.service');

beforeEach(() => {
  inserted.length = 0;
});

describe('activity service audit helpers', () => {
  it('envvar.updated stores the key and changed field names only', async () => {
    await activityService.logEnvVarUpdated('org-A', 'user-1', 'p-1', 'STRIPE_KEY', ['value', 'isSecret']);
    expect(inserted[0]).toMatchObject({
      organizationId: 'org-A',
      userId: 'user-1',
      projectId: 'p-1',
      action: 'envvar.updated',
      metadata: { key: 'STRIPE_KEY', changed: ['value', 'isSecret'] },
    });
    expect(Object.keys(inserted[0].metadata as object).sort()).toEqual(['changed', 'key']);
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

  it('member.removed records the target user and the role they had', async () => {
    await activityService.logMemberRemoved('org-A', 'user-1', 'user-2', 'viewer');
    expect(inserted[0]).toMatchObject({
      action: 'member.removed',
      metadata: { targetUserId: 'user-2', role: 'viewer' },
    });
  });
});
