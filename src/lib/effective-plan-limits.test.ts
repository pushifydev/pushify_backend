import { describe, it, expect } from 'vitest';
import { getEffectivePlanLimits } from './effective-plan-limits';
import { getPlanInfo } from './plans';

/**
 * Regression: planLimitsOverride (the grant-org comp tool) must flow into the effective limits,
 * and everything quota-facing must read the EFFECTIVE limits — a free org granted `servers: 1`
 * once stayed blocked because a static plan limit was consulted instead.
 */
describe('getEffectivePlanLimits', () => {
  it('returns the base plan limits when there is no override', () => {
    const limits = getEffectivePlanLimits({ plan: 'free' });
    expect(limits).toEqual(getPlanInfo('free').limits);
    expect(limits.servers).toBe(1); // free tier's single BYO server
  });

  it('applies a numeric override on top of the plan (grant-org scenario)', () => {
    const limits = getEffectivePlanLimits({
      plan: 'free',
      planLimitsOverride: { servers: 3 },
    });
    expect(limits.servers).toBe(3);
    // Only the overridden key changes.
    expect(limits.projects).toBe(getPlanInfo('free').limits.projects);
    expect(limits.databases).toBe(getPlanInfo('free').limits.databases);
  });

  it('applies boolean feature overrides', () => {
    const limits = getEffectivePlanLimits({
      plan: 'free',
      planLimitsOverride: { previewDeployments: true },
    });
    expect(limits.previewDeployments).toBe(true);
  });

  it('ignores override values of the wrong type', () => {
    const limits = getEffectivePlanLimits({
      plan: 'free',
      planLimitsOverride: { servers: true, previewDeployments: 5 } as Record<
        string,
        number | boolean
      >,
    });
    expect(limits.servers).toBe(getPlanInfo('free').limits.servers);
    expect(limits.previewDeployments).toBe(getPlanInfo('free').limits.previewDeployments);
  });

  it('does not mutate the shared plan definition', () => {
    getEffectivePlanLimits({ plan: 'free', planLimitsOverride: { servers: 99 } });
    expect(getPlanInfo('free').limits.servers).toBe(1);
  });

  it('ignores an expired grandfather window', () => {
    const limits = getEffectivePlanLimits({
      plan: 'free',
      grandfatheredUntil: new Date(Date.now() - 24 * 60 * 60 * 1000),
    });
    expect(limits).toEqual(getPlanInfo('free').limits);
  });
});
