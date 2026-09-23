import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTOSCALE_POLICY,
  MIN_SAMPLES,
  decideScale,
  policyFor,
  validateAutoscaleRange,
  type AutoscaleInput,
} from './autoscale';

/**
 * Almost every test here is about *not* scaling. Reacting to load is the easy half; the half
 * that ruins a production app is a loop that adds a container, sees the average drop because the
 * new one is idle, removes it, and repeats for ever.
 */

const now = new Date(Date.UTC(2026, 8, 23, 12, 0, 0));
const minutesAgo = (n: number) => new Date(now.getTime() - n * 60_000);
const policy = policyFor(1, 5);

const input = (over: Partial<AutoscaleInput> = {}): AutoscaleInput => ({
  current: 2,
  averageCpu: 50,
  sampleCount: 10,
  lastScaledAt: null,
  policy,
  now,
  ...over,
});

describe('decideScale', () => {
  it('leaves a healthy app alone', () => {
    expect(decideScale(input({ averageCpu: 50 }))).toBeNull();
  });

  it('adds one container when CPU is high', () => {
    const decision = decideScale(input({ averageCpu: 85 }));
    expect(decision).toMatchObject({ desired: 3, direction: 'up' });
    expect(decision?.reason).toMatch(/85%/);
  });

  it('removes one when CPU is low', () => {
    expect(decideScale(input({ averageCpu: 10 }))).toMatchObject({ desired: 1, direction: 'down' });
  });

  it('moves one step at a time, however extreme the reading', () => {
    // 100% CPU does not justify jumping to the maximum: containers take time to start, and the
    // reading cannot yet know whether one more is enough
    expect(decideScale(input({ current: 1, averageCpu: 100 }))?.desired).toBe(2);
    expect(decideScale(input({ current: 5, averageCpu: 0, policy: policyFor(1, 5) }))?.desired).toBe(4);
  });

  it('respects the bounds', () => {
    expect(decideScale(input({ current: 5, averageCpu: 99 }))).toBeNull();
    expect(decideScale(input({ current: 1, averageCpu: 1 }))).toBeNull();
  });

  it('decides nothing on too few readings', () => {
    expect(decideScale(input({ averageCpu: 99, sampleCount: MIN_SAMPLES - 1 }))).toBeNull();
    expect(decideScale(input({ averageCpu: 99, sampleCount: 0 }))).toBeNull();
    expect(decideScale(input({ averageCpu: NaN }))).toBeNull();
  });
});

describe('cooldowns', () => {
  it('will not add again straight after adding', () => {
    expect(decideScale(input({ averageCpu: 99, lastScaledAt: minutesAgo(1) }))).toBeNull();
    expect(decideScale(input({ averageCpu: 99, lastScaledAt: minutesAgo(5) }))).not.toBeNull();
  });

  it('waits much longer before removing — a lull is not a trend', () => {
    expect(decideScale(input({ averageCpu: 5, lastScaledAt: minutesAgo(5) }))).toBeNull();
    expect(decideScale(input({ averageCpu: 5, lastScaledAt: minutesAgo(11) }))).not.toBeNull();
    // …and that is deliberately slower than scaling up
    expect(DEFAULT_AUTOSCALE_POLICY.scaleDownCooldownMs).toBeGreaterThan(
      DEFAULT_AUTOSCALE_POLICY.scaleUpCooldownMs
    );
  });

  it('cannot oscillate: the gap between the thresholds is wider than any single step closes', () => {
    // Scale up at 70, down at 30. Adding a third container to two at 70% lands near 47% —
    // nowhere near the scale-down line, so the next reading does not undo the last one.
    const { scaleUpCpu, scaleDownCpu } = DEFAULT_AUTOSCALE_POLICY;
    const afterAdding = (scaleUpCpu * 2) / 3;
    expect(afterAdding).toBeGreaterThan(scaleDownCpu);
  });
});

describe('bounds changed underneath it', () => {
  /**
   * Lowering the maximum in the dashboard has to take effect, and not in ten minutes' time:
   * the bounds are an instruction, the thresholds are a heuristic.
   */
  it('comes back inside the range at once, ignoring cooldown and readings', () => {
    const decision = decideScale(
      input({ current: 8, policy: policyFor(1, 3), averageCpu: 99, sampleCount: 0, lastScaledAt: now })
    );
    expect(decision).toMatchObject({ desired: 3, direction: 'down' });
    expect(decision?.reason).toMatch(/maximum of 3/);
  });

  it('comes up to a raised minimum the same way', () => {
    const decision = decideScale(
      input({ current: 1, policy: policyFor(3, 5), averageCpu: 1, sampleCount: 0, lastScaledAt: now })
    );
    expect(decision).toMatchObject({ desired: 3, direction: 'up' });
    expect(decision?.reason).toMatch(/minimum of 3/);
  });
});

describe('policyFor', () => {
  it('never allows a nonsensical range through', () => {
    expect(policyFor(0, 0)).toMatchObject({ min: 1, max: 1 });
    expect(policyFor(5, 2)).toMatchObject({ min: 5, max: 5 });
    expect(policyFor(null, null)).toMatchObject({ min: 1, max: 1 });
  });
});

describe('validateAutoscaleRange', () => {
  it('accepts a sane range within the plan', () => {
    expect(validateAutoscaleRange(1, 5, 10)).toBeNull();
    expect(validateAutoscaleRange(2, 2, 10)).toBeNull();
  });

  it('refuses the rest, and says which limit was hit', () => {
    expect(validateAutoscaleRange(0, 5, 10)).toMatch(/at least 1/);
    expect(validateAutoscaleRange(5, 2, 10)).toMatch(/greater than or equal/);
    expect(validateAutoscaleRange(1, 20, 10)).toMatch(/at most 10/);
    expect(validateAutoscaleRange(1.5, 5, 10)).toMatch(/whole numbers/);
  });
});
