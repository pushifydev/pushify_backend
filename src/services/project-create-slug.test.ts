import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Slugs are unique within an organization, but on Pushify's shared runners containers, ports and
 * vhosts are named after the slug in every organization, and a deploy whose slug another project
 * there answers to is refused. A project created without a server of its own must therefore get
 * a slug no live runner project uses — otherwise its first deploy fails ("spiderpanel").
 */
const mocks = vi.hoisted(() => ({
  slugExists: vi.fn(async (_org: string, _slug: string) => false),
  runnerTaken: vi.fn(async (_slug: string) => false),
  create: vi.fn(async (values: Record<string, unknown>) => ({ id: 'project-1', ...values })),
  findServer: vi.fn(async () => ({ id: 'server-1', status: 'running', setupStatus: 'completed' })),
}));

vi.mock('../lib/org-access', () => ({ requireOrgMember: vi.fn(async () => ({ role: 'owner' })) }));
vi.mock('./organization-billing.service', () => ({ assertOrganizationCanMutateResources: vi.fn(async () => undefined) }));
vi.mock('./plan-limits.service', () => ({ planLimitsService: { assertProjectsQuota: vi.fn(async () => undefined) } }));
vi.mock('./admin-notify.service', () => ({ adminNotify: vi.fn() }));
vi.mock('../repositories/project.repository', () => ({
  projectRepository: { slugExists: mocks.slugExists, create: mocks.create },
}));
vi.mock('../lib/project-containers', () => ({ sharedRunnerSlugTaken: mocks.runnerTaken }));
vi.mock('../db', () => ({ db: { query: { servers: { findFirst: mocks.findServer } } } }));

import { projectService } from './project.service';

const create = (input: { name: string; serverId?: string }) => projectService.create('org-1', 'user-1', input, 'en');
const createdSlug = () => (mocks.create.mock.calls.at(-1)?.[0] as { slug: string }).slug;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.slugExists.mockResolvedValue(false);
  mocks.runnerTaken.mockResolvedValue(false);
});

describe('projectService.create slug', () => {
  it('keeps the plain slug when nobody uses it', async () => {
    await create({ name: 'Spider Panel' });

    expect(createdSlug()).toBe('spider-panel');
    expect(mocks.runnerTaken).toHaveBeenCalledWith('spider-panel');
  });

  it('suffixes a slug another organization already uses on the shared runners', async () => {
    mocks.runnerTaken.mockImplementation(async (slug) => slug === 'spiderpanel');

    await create({ name: 'spiderpanel' });

    expect(createdSlug()).toMatch(/^spiderpanel-[a-z0-9]{1,4}$/);
    expect(mocks.runnerTaken).toHaveBeenLastCalledWith(createdSlug());
  });

  it('checks the suffixed slug again and picks another one if that is taken too', async () => {
    mocks.runnerTaken.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);

    await create({ name: 'spiderpanel' });

    expect(mocks.runnerTaken).toHaveBeenCalledTimes(3);
    expect(createdSlug()).toMatch(/^spiderpanel-[a-z0-9]{1,4}$/);
  });

  it('still suffixes a slug taken within the organization', async () => {
    mocks.slugExists.mockImplementation(async (_org, slug) => slug === 'spiderpanel');

    await create({ name: 'spiderpanel' });

    expect(createdSlug()).toMatch(/^spiderpanel-[a-z0-9]{1,4}$/);
  });

  it('does not look at the shared runners for a project on its own server', async () => {
    mocks.runnerTaken.mockResolvedValue(true);

    await create({ name: 'spiderpanel', serverId: 'server-1' });

    expect(createdSlug()).toBe('spiderpanel');
    expect(mocks.runnerTaken).not.toHaveBeenCalled();
  });
});
