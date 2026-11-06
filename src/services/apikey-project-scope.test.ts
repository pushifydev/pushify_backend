import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A key can only be limited to projects of its organization that its creator can reach when it is
 * created or changed. Repositories and the member allowlist are mocked; no database is used.
 */
const { h } = vi.hoisted(() => ({
  h: {
    findMember: vi.fn(),
    countByUser: vi.fn(),
    create: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    findByOrganization: vi.fn(),
    getMemberAllowedProjectIds: vi.fn(),
  },
}));

vi.mock('../repositories/organization.repository', () => ({
  organizationRepository: { findMember: h.findMember },
}));
vi.mock('../repositories/apikey.repository', () => ({
  apiKeyRepository: { countByUser: h.countByUser, create: h.create, findById: h.findById, update: h.update },
}));
vi.mock('../repositories/project.repository', () => ({
  projectRepository: { findByOrganization: h.findByOrganization },
}));
vi.mock('../lib/member-project-scope', () => ({
  getMemberAllowedProjectIds: h.getMemberAllowedProjectIds,
}));
vi.mock('../lib/user-ban', () => ({ isUserBanned: async () => false }));

import { apiKeyService } from './apikey.service';

const ORG = 'org-1';
const USER = 'user-1';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

/** The organization's live (non-deleted) projects, as findByOrganization would filter them */
let orgProjects: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  orgProjects = [A, B];
  h.findMember.mockResolvedValue({ role: 'admin', restrictedAccess: false });
  h.countByUser.mockResolvedValue(0);
  h.getMemberAllowedProjectIds.mockResolvedValue(null);
  h.findByOrganization.mockImplementation(async (_org: string, ids: string[]) =>
    orgProjects.filter((id) => ids.includes(id)).map((id) => ({ id }))
  );
  h.create.mockImplementation(async (data: Record<string, unknown>) => ({
    id: 'key-1',
    createdAt: new Date(),
    isActive: true,
    lastUsedAt: null,
    ...data,
  }));
});

describe('apiKeyService.create with projectIds', () => {
  it('stores no limit when projectIds is left out (as before)', async () => {
    const key = await apiKeyService.create(USER, ORG, { name: 'ci' });
    expect(h.create.mock.calls[0][0].projectIds).toBeNull();
    expect(key.projectIds).toBeNull();
    expect(h.findByOrganization).not.toHaveBeenCalled();
  });

  it('stores a normalised list of projects the creator can reach', async () => {
    const key = await apiKeyService.create(USER, ORG, { name: 'ci', projectIds: [A.toUpperCase(), A] });
    expect(h.create.mock.calls[0][0].projectIds).toEqual([A]);
    expect(key.projectIds).toEqual([A]);
  });

  it('refuses a project that is not in the organization (or deleted)', async () => {
    orgProjects = [A];
    await expect(apiKeyService.create(USER, ORG, { name: 'ci', projectIds: [A, B] })).rejects.toMatchObject({
      status: 400,
    });
    expect(h.create).not.toHaveBeenCalled();
  });

  it('refuses a project outside a restricted creator access, with the same answer', async () => {
    h.findMember.mockResolvedValue({ role: 'member', restrictedAccess: true });
    h.getMemberAllowedProjectIds.mockResolvedValue([A]);
    await expect(apiKeyService.create(USER, ORG, { name: 'ci', projectIds: [B] })).rejects.toMatchObject({
      status: 400,
    });
    expect(h.create).not.toHaveBeenCalled();

    await apiKeyService.create(USER, ORG, { name: 'ci', projectIds: [A] });
    expect(h.create.mock.calls[0][0].projectIds).toEqual([A]);
  });

  it('refuses an empty list (it would mean no project, never every project)', async () => {
    await expect(apiKeyService.create(USER, ORG, { name: 'ci', projectIds: [] })).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe('apiKeyService.update with projectIds', () => {
  beforeEach(() => {
    h.findById.mockResolvedValue({ id: 'key-1', userId: USER, organizationId: ORG });
    h.update.mockImplementation(async (_id: string, data: Record<string, unknown>) => ({
      id: 'key-1',
      name: 'ci',
      prefix: 'pk_live_abcd',
      scopes: '*',
      isActive: true,
      lastUsedAt: null,
      createdAt: new Date(),
      expiresAt: null,
      projectIds: null,
      ...data,
    }));
  });

  it('checks the new list against the key organization and the creator', async () => {
    const key = await apiKeyService.update('key-1', USER, ORG, { projectIds: [B] });
    expect(h.findByOrganization).toHaveBeenCalledWith(ORG, [B]);
    expect(key.projectIds).toEqual([B]);
  });

  it('lifts the limit with null and leaves it alone when projectIds is not sent', async () => {
    await apiKeyService.update('key-1', USER, ORG, { projectIds: null });
    expect(h.update.mock.calls[0][1]).toEqual({ projectIds: null });

    await apiKeyService.update('key-1', USER, ORG, { name: 'renamed' });
    expect(h.update.mock.calls[1][1]).toEqual({ name: 'renamed' });
  });

  it('refuses a project the creator cannot reach', async () => {
    orgProjects = [A];
    await expect(apiKeyService.update('key-1', USER, ORG, { projectIds: [B] })).rejects.toMatchObject({
      status: 400,
    });
    expect(h.update).not.toHaveBeenCalled();
  });
});
