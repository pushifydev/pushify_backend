import { describe, expect, it } from 'vitest';
import { policyReviewFields } from './deploy-policy-review';

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
