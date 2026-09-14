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
