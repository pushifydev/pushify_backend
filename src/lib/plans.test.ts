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
  it('free tier has no managed resources', () => {
    expect(PLAN_LIMITS.free.limits.servers).toBe(0);
    expect(PLAN_LIMITS.free.limits.databases).toBe(0);
    expect(PLAN_LIMITS.free.limits.previewDeployments).toBe(false);
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
