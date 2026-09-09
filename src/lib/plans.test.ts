import { describe, it, expect } from 'vitest';
import { getApiRequestsPerMinute, getPlanInfo, PLAN_LIMITS } from './plans';

describe('getApiRequestsPerMinute', () => {
  it('returns plan limits matching public docs', () => {
    expect(getApiRequestsPerMinute('free')).toBe(60);
    expect(getApiRequestsPerMinute('hobby')).toBe(120);
    expect(getApiRequestsPerMinute('pro')).toBe(300);
    expect(getApiRequestsPerMinute('business')).toBe(600);
    expect(getApiRequestsPerMinute('enterprise')).toBe(-1);
  });
});

describe('PLAN_LIMITS v2', () => {
  it('free tier allows one BYO server + database so the product is try-able', () => {
    expect(PLAN_LIMITS.free.limits.servers).toBe(1);
    expect(PLAN_LIMITS.free.limits.databases).toBe(1);
    expect(PLAN_LIMITS.free.limits.previewDeployments).toBe(false);
    // Managed compute stays paid-only — free grants no infra credit.
    expect(PLAN_LIMITS.free.includedInfraCreditCents).toBe(0);
  });

  it('paid entry tiers price above their included infra credit ceiling', () => {
    // Guard the unit economics: the credit ceiling must stay below the plan price
    // so a fully-used credit still leaves platform margin.
    expect(PLAN_LIMITS.hobby.price).toBe(15);
    expect(PLAN_LIMITS.hobby.includedInfraCreditCents).toBeLessThan(PLAN_LIMITS.hobby.price * 100);
    expect(PLAN_LIMITS.pro.price).toBe(29);
    expect(PLAN_LIMITS.pro.includedInfraCreditCents).toBeLessThan(PLAN_LIMITS.pro.price * 100);
  });

  it('hobby is tighter than legacy generous defaults', () => {
    const hobby = getPlanInfo('hobby').limits;
    expect(hobby.databases).toBe(1);
    expect(hobby.projects).toBe(5);
    expect(hobby.deploymentsPerMonth).toBe(150);
  });

  it('pro is the growth tier with moderate caps', () => {
    const pro = getPlanInfo('pro').limits;
    expect(pro.servers).toBe(3);
    expect(pro.teamMembers).toBe(5);
    expect(pro.buildMinutesPerMonth).toBe(750);
  });
});
