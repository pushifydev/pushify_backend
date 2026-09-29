import { describe, it, expect } from 'vitest';
import { isAllowedWhilePendingDeletion } from './deletion-lock';

describe('isAllowedWhilePendingDeletion', () => {
  it('lets reads through', () => {
    for (const m of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(isAllowedWhilePendingDeletion(m, '/api/v1/projects')).toBe(true);
    }
  });

  it('allows restoring, leaving, signing out and taking a domain out', () => {
    expect(isAllowedWhilePendingDeletion('DELETE', '/api/v1/organizations/deletion')).toBe(true);
    expect(isAllowedWhilePendingDeletion('POST', '/api/v1/organizations/switch')).toBe(true);
    expect(isAllowedWhilePendingDeletion('POST', '/api/v1/auth/logout')).toBe(true);
    expect(isAllowedWhilePendingDeletion('POST', '/api/v1/auth/me/deletion')).toBe(true);
    expect(isAllowedWhilePendingDeletion('POST', '/api/v1/domains/example.com/auth-code')).toBe(true);
  });

  it('refuses every other change', () => {
    expect(isAllowedWhilePendingDeletion('POST', '/api/v1/projects')).toBe(false);
    expect(isAllowedWhilePendingDeletion('PATCH', '/api/v1/organizations')).toBe(false);
    expect(isAllowedWhilePendingDeletion('POST', '/api/v1/domains/example.com/auth-code/extra')).toBe(false);
    expect(isAllowedWhilePendingDeletion('POST', '/api/v1/organizations/deletion/../members')).toBe(false);
    expect(isAllowedWhilePendingDeletion('PUT', '/api/v1/projects/abc/env')).toBe(false);
  });
});
