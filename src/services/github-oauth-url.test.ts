import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/env', () => ({
  env: { GITHUB_CLIENT_ID: 'client-1', GITHUB_CALLBACK_URL: 'https://pushify.dev/auth/github/callback' },
}));

import { githubService } from './github.service';

const paramsOf = (url: string) => new URL(url).searchParams;

describe('githubService.getAuthorizationUrl', () => {
  it('always asks for repo access, App or not', () => {
    // Identity-only tokens could not clone private repositories.
    expect(paramsOf(githubService.getAuthorizationUrl('s')).get('scope')).toBe('repo read:user user:email');
  });

  it('shows the account picker when connecting, so another GitHub account can be chosen', () => {
    expect(paramsOf(githubService.getAuthorizationUrl('s', { selectAccount: true })).get('prompt')).toBe('select_account');
  });

  it('leaves sign-in without the picker', () => {
    expect(paramsOf(githubService.getAuthorizationUrl('s')).get('prompt')).toBeNull();
  });
});
