import { describe, it, expect } from 'vitest';
import { memberHasFullProjectAccess } from './member-project-scope';

describe('memberHasFullProjectAccess', () => {
  it('owner and admin bypass restrictions even when flagged', () => {
    expect(memberHasFullProjectAccess({ role: 'owner', restrictedAccess: true })).toBe(true);
    expect(memberHasFullProjectAccess({ role: 'admin', restrictedAccess: true })).toBe(true);
  });

  it('member/viewer without the flag keep full access (legacy default)', () => {
    expect(memberHasFullProjectAccess({ role: 'member', restrictedAccess: false })).toBe(true);
    expect(memberHasFullProjectAccess({ role: 'viewer' })).toBe(true);
    expect(memberHasFullProjectAccess({ role: 'member', restrictedAccess: null })).toBe(true);
  });

  it('flagged member/viewer are restricted', () => {
    expect(memberHasFullProjectAccess({ role: 'member', restrictedAccess: true })).toBe(false);
    expect(memberHasFullProjectAccess({ role: 'viewer', restrictedAccess: true })).toBe(false);
  });
});
