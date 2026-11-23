import { beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => ({ SERVICE_CLOSING_DATE: undefined as string | undefined }));
vi.mock('../config/env', () => ({ env }));
vi.mock('../db', () => ({ db: {} }));

import { assertServiceOpenFor, serviceClosingDate } from './service-closure';
import { assertSignupAllowed } from './user-ban';

beforeEach(() => {
  env.SERVICE_CLOSING_DATE = undefined;
});

describe('service closure', () => {
  it('does nothing when no closing date is set (the default, and self-hosted installs)', async () => {
    expect(serviceClosingDate()).toBeNull();
    expect(() => assertServiceOpenFor('subscription')).not.toThrow();
    await expect(assertSignupAllowed({})).resolves.toBeUndefined();
  });

  it('refuses new sign-ups, payments and managed servers once a date is set', async () => {
    env.SERVICE_CLOSING_DATE = '2026-12-15';
    expect(serviceClosingDate()).toBe('2026-12-15');
    for (const action of ['signup', 'subscription', 'topup', 'domain-purchase', 'managed-server'] as const) {
      expect(() => assertServiceOpenFor(action)).toThrow(/closing on 2026-12-15/);
    }
    await expect(assertSignupAllowed({ email: 'new@example.com' })).rejects.toMatchObject({ status: 403 });
  });

  it('ignores a malformed date instead of closing by accident', () => {
    env.SERVICE_CLOSING_DATE = 'soon';
    expect(serviceClosingDate()).toBeNull();
    expect(() => assertServiceOpenFor('signup')).not.toThrow();
  });
});
