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

export interface PolicyBlockDetails {
  /** The policy that stopped the deploy; the Acceptable Use Policy is the only one */
  policy: 'acceptable_use';
  /** Section the suspension cites (e.g. proxy-vpn); null once the suspension was lifted */
  clause: string | null;
  /** That section's title, e.g. "Acceptable Use §2.1 — proxy, VPN, tunnel and relay services" */
  clauseTitle: string | null;
  /** The reason of the suspension, as the owner was emailed it; null once the suspension was lifted */
  reason: string | null;
  /** The Acceptable Use page, at the cited section when there is one */
  docsUrl: string;
  /** Where to appeal (ABUSE_CONTACT_EMAIL) */
  appealEmail: string;
}

/**
 * What a deploy stopped under the Acceptable Use Policy can show instead of a bare "Stopped by
 * policy": the section and reason of the project's suspension (what the owner is emailed and
 * GET /projects/:id already returns), the policy page and the appeal address. Never what the
 * check matched — rules, files, lines, score stay with the reviewers. Null for every other deploy.
 */
export function policyBlockDetails(
  deployment: { failureCategory?: string | null },
  project: { suspendedAt: Date | null; suspensionClause?: string | null; suspensionReason?: string | null },
  ctx: { clauseTitles: Readonly<Record<string, string>>; frontendUrl: string; appealEmail: string },
): PolicyBlockDetails | null {
  if (!isPolicyBlocked(deployment)) return null;
  const suspended = !!project.suspendedAt;
  const clause = suspended ? project.suspensionClause ?? null : null;
  const clauseTitle =
    clause !== null && Object.prototype.hasOwnProperty.call(ctx.clauseTitles, clause) ? ctx.clauseTitles[clause] : null;
  // Same page as the suspension email; its anchors are the clause keys
  const policyUrl = `${ctx.frontendUrl}/acceptable-use`;
  return {
    policy: 'acceptable_use',
    clause,
    clauseTitle,
    reason: suspended ? project.suspensionReason ?? null : null,
    docsUrl: clauseTitle ? `${policyUrl}#${clause}` : policyUrl,
    appealEmail: ctx.appealEmail,
  };
}
