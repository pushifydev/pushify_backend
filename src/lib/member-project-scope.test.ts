import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * A project-scoped API key narrows the creator's own project access, never widens it: the checks
 * every project route already runs for restricted members also apply the key's list, for owners
 * and admins too. The member allowlist (member_project_access) is faked; no database is used.
 */
const { allowlist } = vi.hoisted(() => ({ allowlist: { rows: [] as string[] } }));

vi.mock('../db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => allowlist.rows.map((projectId) => ({ projectId })),
      }),
    }),
    query: {
      memberProjectAccess: {
        // The test only asks for ids that are either in the allowlist or not
        findFirst: vi.fn(async () => (allowlist.rows.length ? { id: 'row' } : undefined)),
      },
    },
  },
}));

import { db } from '../db';
import {
  assertMemberProjectScope,
  getMemberAllowedProjectIds,
  memberCanAccessProject,
} from './member-project-scope';
import { runWithApiKeyProjectScope } from './api-key-project-scope';

const ORG = 'org-1';
const USER = 'user-1';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

const owner = { role: 'owner', restrictedAccess: false };
const admin = { role: 'admin', restrictedAccess: false };
const restrictedMember = { role: 'member', restrictedAccess: true };

beforeEach(() => {
  allowlist.rows = [];
  vi.mocked(db.query.memberProjectAccess.findFirst).mockClear();
});

describe('without an API key project scope (sessions, unscoped keys)', () => {
  it('keeps today behaviour', async () => {
    expect(await getMemberAllowedProjectIds(owner, ORG, USER)).toBeNull();
    expect(await memberCanAccessProject(admin, ORG, USER, B)).toBe(true);

    allowlist.rows = [A];
    expect(await getMemberAllowedProjectIds(restrictedMember, ORG, USER)).toEqual([A]);
  });
});

describe('with a project-scoped API key', () => {
  it('limits an owner or admin key to its projects', async () => {
    await runWithApiKeyProjectScope([A], async () => {
      expect(await getMemberAllowedProjectIds(owner, ORG, USER)).toEqual([A]);
      expect(await memberCanAccessProject(admin, ORG, USER, A)).toBe(true);
      expect(await memberCanAccessProject(admin, ORG, USER, B)).toBe(false);
      expect(await memberCanAccessProject(owner, ORG, USER, A.toUpperCase())).toBe(true);
    });
  });

  it('answers the same 404 as for a restricted member for a project outside the key', async () => {
    await runWithApiKeyProjectScope([A], async () => {
      await expect(assertMemberProjectScope(owner, ORG, USER, B)).rejects.toMatchObject({ status: 404 });
      await expect(assertMemberProjectScope(owner, ORG, USER, A)).resolves.toBeUndefined();
    });
  });

  it('never goes past the creator: a restricted member key gets the intersection', async () => {
    allowlist.rows = [A, C];
    await runWithApiKeyProjectScope([A, B], async () => {
      expect(await getMemberAllowedProjectIds(restrictedMember, ORG, USER)).toEqual([A]);
      // B is in the key but not the member's allowlist: the member check still runs and refuses it
      allowlist.rows = [];
      expect(await memberCanAccessProject(restrictedMember, ORG, USER, B)).toBe(false);
    });
  });

  it('stops reaching a project the creator lost, even if the key still lists it', async () => {
    allowlist.rows = [];
    await runWithApiKeyProjectScope([A], async () => {
      expect(await getMemberAllowedProjectIds(restrictedMember, ORG, USER)).toEqual([]);
      expect(await memberCanAccessProject(restrictedMember, ORG, USER, A)).toBe(false);
    });
  });

  it('refuses a project outside the key without looking up the member allowlist', async () => {
    await runWithApiKeyProjectScope([A], async () => {
      expect(await memberCanAccessProject(restrictedMember, ORG, USER, C)).toBe(false);
    });
    expect(db.query.memberProjectAccess.findFirst).not.toHaveBeenCalled();
  });
});
