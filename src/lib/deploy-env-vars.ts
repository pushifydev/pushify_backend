/**
 * Which of a project's environment variables a deploy injects.
 *
 * The `environment` column (production / staging / development / preview) was written by the
 * API and shown in the dashboard but never read at deploy time: every deploy received every
 * row, so staging and development values reached production containers and PR previews got
 * the production secrets. Now a production deploy gets `production` rows only, and a preview
 * deploy gets `production` with `preview` rows layered on top — so a preview works out of the
 * box and a `preview` value (a staging database, say) overrides its production twin.
 * A staging deploy layers `staging` rows the same way; `development` rows are never injected.
 */
export type DeployEnvironment = 'production' | 'staging' | 'development' | 'preview';

export interface DeployEnvVarLike {
  key: string;
  environment: DeployEnvironment;
}

/** Which copy of the project a deploy is for. */
export type DeployTarget = 'production' | 'staging' | 'preview';

/**
 * Production rows are the base for every target; a staging or preview deploy layers its own rows
 * on top, so it works out of the box and only differs where the person said it should.
 * `development` rows are the person's own scratch space and are never injected.
 */
export function selectDeployEnvVars<T extends DeployEnvVarLike>(
  rows: T[],
  opts: { target: DeployTarget } | { preview: boolean }
): T[] {
  const target: DeployTarget = 'target' in opts ? opts.target : opts.preview ? 'preview' : 'production';
  const byKey = new Map<string, T>();
  for (const row of rows) {
    if (row.environment === 'production') byKey.set(row.key, row);
  }
  if (target !== 'production') {
    for (const row of rows) {
      if (row.environment === target) byKey.set(row.key, row);
    }
  }
  return [...byKey.values()];
}
