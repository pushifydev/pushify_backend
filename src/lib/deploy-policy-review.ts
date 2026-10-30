import { isPolicyBlocked } from './deploy-failure-summary';

export interface PolicyReviewFields {
  /** The owner can ask a person to review this deploy (POST …/deployments/:id/review-request) */
  reviewRequestable: boolean;
  /** When a review of this deploy was requested; null when none was */
  reviewRequestedAt: Date | null;
}

/**
 * Whether a deploy can be put to a person for review: the automatic Acceptable Use check stopped
 * it (policy_blocked), the hosted-service rules are on, its project is still suspended and no
 * review was requested for it yet. Decided from the stored category; says nothing about what the
 * check found.
 */
export function policyReviewFields(
  deployment: { failureCategory?: string | null },
  ctx: { detectionEnabled: boolean; projectSuspended: boolean; requestedAt: Date | null },
): PolicyReviewFields {
  return {
    reviewRequestable:
      ctx.detectionEnabled && ctx.projectSuspended && ctx.requestedAt === null && isPolicyBlocked(deployment),
    reviewRequestedAt: ctx.requestedAt,
  };
}
