import { describe, it, expect, beforeEach, vi } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * Maintenance mode is switched in the database and then on the server (vhost rewrite + nginx -t
 * + reload). Owners/admins only; when nginx rejects the config the stored value is put back so
 * the next deploy doesn't flip the site into (or out of) maintenance on its own.
 */
const mocks = vi.hoisted(() => ({
  requireProjectMember: vi.fn(),
  saved: [] as unknown[],
  resync: vi.fn(async () => true),
}));

vi.mock('../lib/org-access', () => ({
  requireOrgMember: vi.fn(),
  requireProjectMember: mocks.requireProjectMember,
}));
vi.mock('./organization-billing.service', () => ({ assertOrganizationCanMutateResources: vi.fn() }));
vi.mock('./plan-limits.service', () => ({ planLimitsService: {} }));
vi.mock('./admin-notify.service', () => ({ adminNotify: vi.fn() }));
vi.mock('../lib/project-containers', () => ({ sharedRunnerSlugTaken: vi.fn() }));
vi.mock('./domain.service', () => ({ domainService: { resyncProjectSites: mocks.resync } }));
vi.mock('../db', () => ({
  db: {
    update: () => ({
      set: (values: { maintenanceMode: unknown }) => ({
        where: () => ({
          returning: async () => {
            mocks.saved.push(values.maintenanceMode);
            return [{ ...project(), maintenanceMode: values.maintenanceMode }];
          },
        }),
      }),
    }),
  },
}));

import { projectService } from './project.service';

const project = (extra: Record<string, unknown> = {}) => ({
  id: 'project-1',
  name: 'Yeli',
  slug: 'yeli',
  serverId: 'server-1',
  status: 'active',
  suspendedAt: null,
  maintenanceMode: { enabled: false, message: 'Old note' },
  ...extra,
});

const set = (input: { enabled: boolean; message?: string }) =>
  projectService.setMaintenanceMode('project-1', 'org-1', 'user-1', input, 'en');

beforeEach(() => {
  vi.clearAllMocks();
  mocks.saved.length = 0;
  mocks.resync.mockResolvedValue(true);
  mocks.requireProjectMember.mockResolvedValue({ membership: { role: 'admin' }, project: project() });
});

describe('projectService.setMaintenanceMode', () => {
  it('requires at least admin on the project', async () => {
    mocks.requireProjectMember.mockRejectedValue(new HTTPException(403, { message: 'forbidden' }));

    await expect(set({ enabled: true })).rejects.toMatchObject({ status: 403 });
    expect(mocks.requireProjectMember).toHaveBeenCalledWith('project-1', 'org-1', 'user-1', 'admin', 'en');
    expect(mocks.saved).toEqual([]);
    expect(mocks.resync).not.toHaveBeenCalled();
  });

  it('stores the mode and rewrites the vhost — no container is touched', async () => {
    const result = await set({ enabled: true, message: '  Back at 14:00  ' });

    expect(mocks.saved).toEqual([{ enabled: true, message: 'Back at 14:00' }]);
    expect(mocks.resync).toHaveBeenCalledTimes(1);
    expect(result.applied).toBe(true);
    expect(result.previous).toEqual({ enabled: false, message: 'Old note' });
  });

  it('keeps the stored message when none is sent', async () => {
    await set({ enabled: true });
    expect(mocks.saved).toEqual([{ enabled: true, message: 'Old note' }]);
  });

  it('puts the previous value back when nginx rejects the config', async () => {
    mocks.resync.mockRejectedValue(new Error('Nginx configuration test failed: emerg'));

    await expect(set({ enabled: true })).rejects.toMatchObject({ status: 500 });
    expect(mocks.saved).toEqual([
      { enabled: true, message: 'Old note' },
      { enabled: false, message: 'Old note' },
    ]);
  });

  it('reports a project without a ready server as stored but not applied yet', async () => {
    mocks.resync.mockResolvedValue(false);
    const result = await set({ enabled: true });
    expect(result.applied).toBe(false);
  });

  it('will not cover a suspension notice with a maintenance page', async () => {
    mocks.requireProjectMember.mockResolvedValue({ membership: { role: 'owner' }, project: project({ suspendedAt: new Date() }) });

    await expect(set({ enabled: true })).rejects.toMatchObject({ status: 403 });
    expect(mocks.saved).toEqual([]);
  });
});
