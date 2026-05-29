import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./redis-client', () => ({
  getOptionalRedis: (): null => null,
}));

import {
  createOAuthState,
  consumeOAuthState,
  validateOAuthStateRecord,
} from './oauth-state-store';

describe('oauth-state-store (memory fallback)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates and consumes github integration state', async () => {
    const state = await createOAuthState({
      kind: 'github_integration',
      userId: 'user-1',
    });

    const record = await consumeOAuthState(state);
    expect(validateOAuthStateRecord(record, { kind: 'github_integration', userId: 'user-1' })).toBe(
      true,
    );
    expect(await consumeOAuthState(state)).toBeNull();
  });

  it('rejects wrong user on integration state', async () => {
    const state = await createOAuthState({
      kind: 'github_integration',
      userId: 'user-1',
    });
    const record = await consumeOAuthState(state);
    expect(validateOAuthStateRecord(record, { kind: 'github_integration', userId: 'user-2' })).toBe(
      false,
    );
  });

  it('creates and consumes login state without userId', async () => {
    const state = await createOAuthState({ kind: 'github_login' });
    const record = await consumeOAuthState(state);
    expect(validateOAuthStateRecord(record, { kind: 'github_login' })).toBe(true);
  });
});
