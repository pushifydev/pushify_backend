import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * A deploy stopped by the automatic Acceptable Use check: what the owner sees about it
 * (reviewRequestable / reviewRequestedAt, nothing about the detection) and asking for a review —
 * once per deploy, member and up, only while the project is suspended.
 */

const h = vi.hoisted(() => ({
  role: 'member',
  project: { id: 'proj-1', organizationId: 'org-1', status: 'paused', suspendedAt: new Date('2026-10-29T00:00:00Z') as Date | null },
  deployment: { id: 'dep-1', projectId: 'proj-1', status: 'failed', failureCategory: 'policy_blocked' as string | null },
  detectionEnabled: true,
  requested: new Map<string, Date>(),
  requestDeployReview: vi.fn(),
  reviewRequestsFor: vi.fn(),
}));

vi.mock('../db', () => ({ db: {} }));
vi.mock('../repositories/deployment.repository', () => ({
  deploymentRepository: {
    findById: async (id: string) => (id === h.deployment.id ? { ...h.deployment } : null),
    findByIdWithProject: async (id: string) => (id === h.deployment.id ? { ...h.deployment } : null),
    findByProject: async () => [{ ...h.deployment }, { id: 'dep-0', projectId: 'proj-1', status: 'running', failureCategory: null }],
  },
}));
vi.mock('../repositories/project.repository', () => ({
  projectRepository: { findById: async () => ({ ...h.project }) },
}));
vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findMember: async () => ({ role: h.role, restrictedAccess: false }) },
}));
vi.mock('../lib/member-project-scope', () => ({ assertMemberProjectScope: async () => undefined }));
vi.mock('./organization-billing.service', () => ({ assertOrganizationCanMutateResources: vi.fn() }));
vi.mock('./plan-limits.service', () => ({ planLimitsService: {} }));
vi.mock('./abuse.service', () => ({
  abuseDetectionEnabled: () => h.detectionEnabled,
  abuseService: { requestDeployReview: h.requestDeployReview, reviewRequestsFor: h.reviewRequestsFor },
}));

import { deploymentService } from './deployment.service';

const request = (note: string | null = 'This is a WebSocket chat, not a proxy.') =>
  deploymentService.requestPolicyReview('dep-1', 'proj-1', 'org-1', 'user-1', note, 'en');

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (err) {
    if (err instanceof HTTPException) return err.status;
    throw err;
  }
}

beforeEach(() => {
  h.role = 'member';
  h.project.suspendedAt = new Date('2026-10-29T00:00:00Z');
  h.deployment.failureCategory = 'policy_blocked';
  h.detectionEnabled = true;
  h.requested = new Map();
  h.reviewRequestsFor.mockReset().mockImplementation(async (ids: string[]) => new Map([...h.requested].filter(([id]) => ids.includes(id))));
  h.requestDeployReview.mockReset().mockResolvedValue({ id: 'flag-1', createdAt: new Date('2026-10-30T09:00:00Z') });
});

describe('deployments stopped by the automatic Acceptable Use check', () => {
  it('lists a stopped deploy as reviewable and looks nothing up for the others', async () => {
    const rows = await deploymentService.getByProject('proj-1', 'org-1', 'user-1', 'en');
    expect(rows[0]).toMatchObject({ id: 'dep-1', reviewRequestable: true, reviewRequestedAt: null });
    expect(rows[1]).toMatchObject({ id: 'dep-0', reviewRequestable: false, reviewRequestedAt: null });
    expect(h.reviewRequestsFor).toHaveBeenCalledWith(['dep-1']);
  });

  it('shows when a review was requested, and no longer offers one', async () => {
    const at = new Date('2026-10-30T08:00:00Z');
    h.requested.set('dep-1', at);
    const deployment = await deploymentService.getById('dep-1', 'proj-1', 'org-1', 'user-1', 'en');
    expect(deployment).toMatchObject({ reviewRequestable: false, reviewRequestedAt: at });
  });

  it('queues a review request with the note and answers without detection details', async () => {
    const res = await request();
    expect(h.requestDeployReview).toHaveBeenCalledWith({
      projectId: 'proj-1',
      organizationId: 'org-1',
      deploymentId: 'dep-1',
      note: 'This is a WebSocket chat, not a proxy.',
    });
    expect(res).toEqual({ id: 'flag-1', status: 'pending', createdAt: new Date('2026-10-30T09:00:00Z') });
  });

  it('answers 409 to a second request for the same deploy', async () => {
    h.requested.set('dep-1', new Date());
    expect(await statusOf(request())).toBe(409);
    expect(h.requestDeployReview).not.toHaveBeenCalled();
  });

  it('answers 409 when a concurrent request got in first (unique index)', async () => {
    h.requestDeployReview.mockResolvedValue(null);
    expect(await statusOf(request())).toBe(409);
  });

  it('refuses deploys that were not stopped by the check, or whose suspension was lifted', async () => {
    h.deployment.failureCategory = 'dependency_install';
    expect(await statusOf(request())).toBe(400);
    h.deployment.failureCategory = 'policy_blocked';
    h.project.suspendedAt = null;
    expect(await statusOf(request())).toBe(400);
    h.project.suspendedAt = new Date();
    h.detectionEnabled = false;
    expect(await statusOf(request())).toBe(400);
    expect(h.requestDeployReview).not.toHaveBeenCalled();
  });

  it('is for members and up, not viewers', async () => {
    h.role = 'viewer';
    expect(await statusOf(request())).toBe(403);
    expect(h.requestDeployReview).not.toHaveBeenCalled();
  });

  it('answers 404 for a deploy of another project', async () => {
    expect(await statusOf(deploymentService.requestPolicyReview('dep-x', 'proj-1', 'org-1', 'user-1', null, 'en'))).toBe(404);
  });
});
