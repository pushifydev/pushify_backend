/**
 * Which of a project's environment variables a deploy injects.
 *
 * The `environment` column (production / staging / development / preview) was written by the
 * API and shown in the dashboard but never read at deploy time: every deploy received every
 * row, so staging and development values reached production containers and PR previews got
 * the production secrets. Now a production deploy gets `production` rows only, and a preview
 * deploy gets `production` with `preview` rows layered on top — so a preview works out of the
 * box and a `preview` value (a staging database, say) overrides its production twin.
 * Staging and development rows are never injected; they are the person's own scratch space.
 */
export type DeployEnvironment = 'production' | 'staging' | 'development' | 'preview';

export interface DeployEnvVarLike {
  key: string;
  environment: DeployEnvironment;
}

export function selectDeployEnvVars<T extends DeployEnvVarLike>(rows: T[], opts: { preview: boolean }): T[] {
  const byKey = new Map<string, T>();
  for (const row of rows) {
    if (row.environment === 'production') byKey.set(row.key, row);
  }
  if (opts.preview) {
    for (const row of rows) {
      if (row.environment === 'preview') byKey.set(row.key, row);
    }
  }
  return [...byKey.values()];
}
