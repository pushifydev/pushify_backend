import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HTTPException } from 'hono/http-exception';

/**
 * Enforced SSO is only worth anything if every other door is shut. A company turns it on so that
 * disabling someone at the identity provider is enough to lock them out — if they could still
 * sign up with a password, or click "Sign in with GitHub" with their work address, the setting
 * would be decoration.
 *
 * So this checks the doors, not the OIDC flow (`lib/oidc.test.ts` covers that): every way in that
 * takes an email address must ask whether that address is under an enforced connection.
 */

const blocked = vi.hoisted(() => ({ domains: new Set<string>() }));

vi.mock('./sso.service', () => ({
  ssoService: {
    isPasswordLoginBlocked: async (email: string) =>
      blocked.domains.has(String(email).toLowerCase().split('@')[1] ?? ''),
  },
}));

import { authService } from './auth.service';

beforeEach(() => {
  blocked.domains = new Set(['acme.com']);
});

const refusal = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof HTTPException ? { status: err.status, message: err.message } : { status: 0, message: String(err) };
  }
};

describe('assertSsoNotEnforced', () => {
  it('refuses an address in an enforced domain, and says where to go instead', async () => {
    const result = await refusal(() => authService.assertSsoNotEnforced('dana@acme.com'));
    expect(result?.status).toBe(403);
    expect(result?.message).toMatch(/identity provider/);
    expect(result?.message).toMatch(/SSO/);
  });

  it('is case-insensitive about the address', async () => {
    expect(await refusal(() => authService.assertSsoNotEnforced('Dana@ACME.com'))).not.toBeNull();
  });

  it('lets every other address through', async () => {
    expect(await refusal(() => authService.assertSsoNotEnforced('dana@other.com'))).toBeNull();
    expect(await refusal(() => authService.assertSsoNotEnforced('dana@sub.acme.com'))).toBeNull();
  });
});

describe('the doors an enforced connection has to close', () => {
  /**
   * Each of these calls `assertSsoNotEnforced` before anything else it does, so the refusal
   * arrives before a password is checked, an account is created or a provider is called.
   */
  it('password login', async () => {
    const result = await refusal(() => authService.login({ email: 'dana@acme.com', password: 'whatever' }));
    expect(result?.status).toBe(403);
    expect(result?.message).toMatch(/identity provider/);
  });

  it('registration — otherwise anyone makes their own organization with a company address', async () => {
    const result = await refusal(() =>
      authService.register({ email: 'dana@acme.com', password: 'Str0ng-passw0rd!', name: 'Dana' })
    );
    expect(result?.status).toBe(403);
    expect(result?.message).toMatch(/identity provider/);
  });

  it('does not leak whether the account exists: the refusal comes first, and reads the same', async () => {
    const known = await refusal(() => authService.login({ email: 'dana@acme.com', password: 'x' }));
    const unknown = await refusal(() => authService.login({ email: 'nobody@acme.com', password: 'x' }));
    expect(known?.message).toBe(unknown?.message);
    expect(known?.status).toBe(403);
  });
});
