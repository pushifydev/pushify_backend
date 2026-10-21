import {
  classifyDeployFailure,
  type DeployFailureBlame,
  type DeployFailureCategory,
} from './deploy-failure-classify';

/**
 * Groups failed deployments by the classifier's category so an operator can see *why*
 * deploys fail across the platform ("40% have no build script, 25% ran out of disk") rather
 * than one failure at a time. Works from `deployments.error_message` alone: the worker stores
 * the classified message there, and re-running the classifier on it lands in the same bucket.
 */

export interface DeployFailureSummary {
  category: DeployFailureCategory;
  blame: DeployFailureBlame;
  label: string;
  hint: string;
  count: number;
  /** Distinct projects affected */
  projects: number;
  /** Most recent raw message in this bucket, "[Blame] Label:" prefix removed */
  sample: string | null;
}

export interface FailedDeploymentRow {
  errorMessage: string | null;
  projectId: string | null;
}

export interface DeployOutcomeRow {
  status: string;
  /** deployments.failure_category, as the worker stored it */
  failureCategory: string | null;
  /** Rows already grouped by status and category carry their count; one deployment is 1. */
  count?: number;
}

export interface DeployOutcomeCounts {
  /** Deployments, without the ones stopped under the Acceptable Use Policy */
  total: number;
  /** Failed deployments, without the ones stopped under the Acceptable Use Policy */
  failed: number;
  /** Stopped under the Acceptable Use Policy: in neither total nor failed */
  policyBlocked: number;
}

/** SQL condition on `deployments`: not stopped under the Acceptable Use Policy (NULL-safe). */
export const NOT_POLICY_BLOCKED_SQL = `failure_category IS DISTINCT FROM 'policy_blocked'`;

export function isPolicyBlocked(row: { failureCategory?: string | null }): boolean {
  return row.failureCategory === 'policy_blocked';
}

/**
 * The counts a failure rate is built from. A deploy stopped under the Acceptable Use Policy did
 * what it should, so it leaves both sides of failed / total and is counted on its own. Decided
 * from the stored category alone, never from the message.
 */
export function countDeployOutcomes(rows: DeployOutcomeRow[]): DeployOutcomeCounts {
  const counts: DeployOutcomeCounts = { total: 0, failed: 0, policyBlocked: 0 };
  for (const row of rows) {
    const n = row.count ?? 1;
    if (isPolicyBlocked(row)) {
      counts.policyBlocked += n;
      continue;
    }
    counts.total += n;
    if (row.status === 'failed') counts.failed += n;
  }
  return counts;
}

// formatClassifiedErrorMessage() writes "[Project] Application build failed: <raw>".
const PREFIX = /^\[(?:Pushify|Server|Project)\]\s+[^:\n]{1,80}:\s*/;

export function stripFailurePrefix(message: string): string {
  return message.replace(PREFIX, '').trim().split('\n')[0].slice(0, 200);
}

/** Rows are expected newest first, so the sample is the latest message in each bucket. */
export function summarizeDeployFailures(rows: FailedDeploymentRow[]): DeployFailureSummary[] {
  const buckets = new Map<DeployFailureCategory, DeployFailureSummary & { projectIds: Set<string> }>();

  for (const row of rows) {
    const classified = classifyDeployFailure('', row.errorMessage ?? '');
    let bucket = buckets.get(classified.category);
    if (!bucket) {
      bucket = {
        category: classified.category,
        blame: classified.blame,
        label: classified.label,
        hint: classified.userHint,
        count: 0,
        projects: 0,
        sample: null,
        projectIds: new Set(),
      };
      buckets.set(classified.category, bucket);
    }
    bucket.count += 1;
    if (row.projectId) bucket.projectIds.add(row.projectId);
    if (bucket.sample === null && row.errorMessage) {
      const sample = stripFailurePrefix(row.errorMessage);
      if (sample) bucket.sample = sample;
    }
  }

  return [...buckets.values()]
    .map(({ projectIds, ...bucket }) => ({ ...bucket, projects: projectIds.size }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
