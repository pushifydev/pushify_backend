import { describe, expect, it } from 'vitest';
import { pickEmail, type OrgProgress } from './onboarding.worker';

const HOUR = 60 * 60 * 1000;

function progress(overrides: Partial<OrgProgress>): OrgProgress {
  return {
    orgId: 'org',
    ageMs: 0,
    ownerEmail: 'a@b.c',
    ownerUserId: 'u',
    optOut: false,
    deployments: 0,
    customDomains: 0,
    databases: 0,
    sent: new Set(),
    ...overrides,
  };
}

describe('pickEmail', () => {
  it('sends first_deploy after ~1 day with no deployments', () => {
    expect(pickEmail(progress({ ageMs: 21 * HOUR }))).toBe('first_deploy');
    expect(pickEmail(progress({ ageMs: 10 * HOUR }))).toBeNull();
  });

  it('never sends first_deploy to someone who already deployed', () => {
    expect(pickEmail(progress({ ageMs: 21 * HOUR, deployments: 2 }))).toBeNull();
  });

  it('sends stuck after ~3 days only when still not deployed and first email went out', () => {
    expect(pickEmail(progress({ ageMs: 69 * HOUR, sent: new Set(['first_deploy']) }))).toBe('stuck');
    expect(pickEmail(progress({ ageMs: 69 * HOUR, deployments: 1, sent: new Set(['first_deploy']) }))).not.toBe('stuck');
  });

  it('sends connect_domain to deployed users without a custom domain', () => {
    expect(pickEmail(progress({ ageMs: 69 * HOUR, deployments: 1 }))).toBe('connect_domain');
    expect(pickEmail(progress({ ageMs: 69 * HOUR, deployments: 1, customDomains: 1 }))).toBeNull();
  });

  it('sends add_database at day 7 to active users without a database', () => {
    const p = progress({ ageMs: 8 * 24 * HOUR, deployments: 3, customDomains: 1, sent: new Set(['connect_domain']) });
    expect(pickEmail(p)).toBe('add_database');
    expect(pickEmail({ ...p, databases: 1 })).toBeNull();
  });

  it('never repeats an email', () => {
    const all = new Set(['first_deploy', 'stuck', 'connect_domain', 'add_database']);
    expect(pickEmail(progress({ ageMs: 30 * 24 * HOUR, sent: all }))).toBeNull();
    expect(pickEmail(progress({ ageMs: 30 * 24 * HOUR, deployments: 5, sent: all }))).toBeNull();
  });
});
