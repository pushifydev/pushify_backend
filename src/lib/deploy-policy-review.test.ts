import { describe, expect, it } from 'vitest';
import { policyBlockDetails, policyReviewFields } from './deploy-policy-review';

const blocked = { failureCategory: 'policy_blocked' };
const open = { detectionEnabled: true, projectSuspended: true, requestedAt: null };

describe('policyReviewFields', () => {
  it('offers a review for a deploy the check stopped while the project is suspended', () => {
    expect(policyReviewFields(blocked, open)).toEqual({ reviewRequestable: true, reviewRequestedAt: null });
  });

  it('offers none once a review was requested, and says when', () => {
    const at = new Date('2026-10-30T10:00:00Z');
    expect(policyReviewFields(blocked, { ...open, requestedAt: at })).toEqual({ reviewRequestable: false, reviewRequestedAt: at });
  });

  it('offers none for ordinary failures or deploys without a category', () => {
    for (const failureCategory of ['dependency_install', 'unknown', null, undefined]) {
      expect(policyReviewFields({ failureCategory }, open).reviewRequestable).toBe(false);
    }
  });

  it('offers none when the suspension was already lifted', () => {
    expect(policyReviewFields(blocked, { ...open, projectSuspended: false }).reviewRequestable).toBe(false);
  });

  it('offers none where the hosted-service rules are off (self-hosted)', () => {
    expect(policyReviewFields(blocked, { ...open, detectionEnabled: false }).reviewRequestable).toBe(false);
  });
});

describe('policyBlockDetails', () => {
  const suspended = {
    suspendedAt: new Date('2026-11-01T00:00:00Z'),
    suspensionClause: 'proxy-vpn',
    suspensionReason: 'Automatic review found downloads or runs xray (vless/vmess proxy).',
  };
  const ctx = {
    clauseTitles: { 'proxy-vpn': 'Acceptable Use §2.1 — proxy, VPN, tunnel and relay services', other: 'Acceptable Use' },
    frontendUrl: 'https://pushify.dev',
    appealEmail: 'abuse@pushify.dev',
  };

  it('names the section and reason of the suspension and links that section of the policy', () => {
    expect(policyBlockDetails(blocked, suspended, ctx)).toEqual({
      policy: 'acceptable_use',
      clause: 'proxy-vpn',
      clauseTitle: 'Acceptable Use §2.1 — proxy, VPN, tunnel and relay services',
      reason: 'Automatic review found downloads or runs xray (vless/vmess proxy).',
      docsUrl: 'https://pushify.dev/acceptable-use#proxy-vpn',
      appealEmail: 'abuse@pushify.dev',
    });
  });

  it('is null for ordinary failures and deploys without a category', () => {
    for (const failureCategory of ['dependency_install', 'unknown', null, undefined]) {
      expect(policyBlockDetails({ failureCategory }, suspended, ctx)).toBeNull();
    }
  });

  it('keeps the policy and its page once the suspension was lifted, without a section or reason', () => {
    const lifted = { suspendedAt: null, suspensionClause: null, suspensionReason: null };
    expect(policyBlockDetails(blocked, lifted, ctx)).toEqual({
      policy: 'acceptable_use',
      clause: null,
      clauseTitle: null,
      reason: null,
      docsUrl: 'https://pushify.dev/acceptable-use',
      appealEmail: 'abuse@pushify.dev',
    });
  });

  it('links the page itself for a section it has no title for', () => {
    const details = policyBlockDetails(blocked, { ...suspended, suspensionClause: 'retired-section' }, ctx);
    expect(details).toMatchObject({ clause: 'retired-section', clauseTitle: null, docsUrl: 'https://pushify.dev/acceptable-use' });
    expect(policyBlockDetails(blocked, { ...suspended, suspensionClause: 'toString' }, ctx)?.clauseTitle).toBeNull();
  });

  it('says nothing about what the check matched', () => {
    const details = policyBlockDetails(blocked, suspended, ctx);
    expect(Object.keys(details ?? {}).sort()).toEqual(['appealEmail', 'clause', 'clauseTitle', 'docsUrl', 'policy', 'reason']);
  });
});
