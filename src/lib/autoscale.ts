/**
 * Deciding how many containers an app should be running.
 *
 * The danger in autoscaling is not being slow to react, it is thrashing: a decision taken on one
 * reading adds a container, the average drops because the new container is idle, the next reading
 * removes it, and the app spends its life starting and stopping. So the rules here are
 * deliberately asymmetric — quick to add, slow to remove, one step at a time, and never twice
 * inside a cooldown.
 *
 * CPU is the signal. Memory is not: more replicas do not help an app that leaks, and an app whose
 * memory is genuinely request-driven will show it in CPU too. Memory pressure is an alert
 * (`lib/resource-alerts.ts`), not a scaling input.
 */

export interface AutoscalePolicy {
  /** Never go below this, whatever the load says */
  min: number;
  /** …or above it */
  max: number;
  /** Average CPU across replicas at or above which another container is added */
  scaleUpCpu: number;
  /** …and at or below which one is removed */
  scaleDownCpu: number;
  /** Adding again is allowed this soon after the last change */
  scaleUpCooldownMs: number;
  /** Removing is allowed only this long after the last change — slower on purpose */
  scaleDownCooldownMs: number;
}

/**
 * Defaults chosen to be dull. 70% leaves headroom for the time it takes a container to start;
 * 30% means a replica is doing almost nothing before one is taken away. Ten minutes before
 * scaling down is long enough that a lunchtime lull does not undo a morning's scale-up.
 */
export const DEFAULT_AUTOSCALE_POLICY: Omit<AutoscalePolicy, 'min' | 'max'> = {
  scaleUpCpu: 70,
  scaleDownCpu: 30,
  scaleUpCooldownMs: 3 * 60 * 1000,
  scaleDownCooldownMs: 10 * 60 * 1000,
};

export interface AutoscaleInput {
  /** Containers running now */
  current: number;
  /** Average CPU across them, over the sampling window */
  averageCpu: number;
  /** How many readings that average came from — too few and we decide nothing */
  sampleCount: number;
  /** When this project last scaled, so a cooldown can be applied */
  lastScaledAt: Date | null;
  policy: AutoscalePolicy;
  now: Date;
}

export interface AutoscaleDecision {
  desired: number;
  direction: 'up' | 'down';
  /** Said in the deploy log and the activity entry, so a change is never mysterious */
  reason: string;
}

/**
 * At least this many readings before acting. At one sample per poll a single spike would
 * otherwise be enough to change the shape of someone's production.
 */
export const MIN_SAMPLES = 3;

/** What the count should become, or null when the answer is "leave it alone". */
export function decideScale(input: AutoscaleInput): AutoscaleDecision | null {
  const { current, averageCpu, sampleCount, lastScaledAt, policy, now } = input;

  // A policy that cannot be satisfied is a configuration mistake, not a scaling event
  const min = Math.max(1, Math.round(policy.min));
  const max = Math.max(min, Math.round(policy.max));

  // Outside its own bounds — usually because someone lowered the maximum. Correct it at once,
  // without waiting for a cooldown or a reading: the bounds are an instruction, not a hint.
  if (current < min) {
    return { desired: min, direction: 'up', reason: `below the minimum of ${min}` };
  }
  if (current > max) {
    return { desired: max, direction: 'down', reason: `above the maximum of ${max}` };
  }

  if (sampleCount < MIN_SAMPLES || !Number.isFinite(averageCpu)) return null;

  const sinceLast = lastScaledAt ? now.getTime() - lastScaledAt.getTime() : Number.POSITIVE_INFINITY;

  if (averageCpu >= policy.scaleUpCpu && current < max) {
    if (sinceLast < policy.scaleUpCooldownMs) return null;
    return {
      desired: current + 1,
      direction: 'up',
      reason: `CPU averaged ${Math.round(averageCpu)}% across ${current} container${current === 1 ? '' : 's'}`,
    };
  }

  if (averageCpu <= policy.scaleDownCpu && current > min) {
    if (sinceLast < policy.scaleDownCooldownMs) return null;
    return {
      desired: current - 1,
      direction: 'down',
      reason: `CPU averaged ${Math.round(averageCpu)}% across ${current} containers`,
    };
  }

  return null;
}

/** The policy for a project, with anything unset falling back to the dull defaults. */
export function policyFor(min: number | null | undefined, max: number | null | undefined): AutoscalePolicy {
  const resolvedMin = Math.max(1, Math.round(min ?? 1));
  return {
    ...DEFAULT_AUTOSCALE_POLICY,
    min: resolvedMin,
    max: Math.max(resolvedMin, Math.round(max ?? resolvedMin)),
  };
}

/** Is this range one we can act on at all? Returns why not, or null. */
export function validateAutoscaleRange(min: number, max: number, planMax: number): string | null {
  if (!Number.isInteger(min) || !Number.isInteger(max)) return 'Minimum and maximum must be whole numbers';
  if (min < 1) return 'Minimum must be at least 1';
  if (max < min) return 'Maximum must be greater than or equal to the minimum';
  if (max > planMax) return `Your plan allows at most ${planMax} containers per project`;
  return null;
}
