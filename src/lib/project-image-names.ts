/**
 * Image repository names a project's builds use. The remote deployer names images
 * `pushify-<slug>` (previews `pushify-<slug>-pr-N`, see workers/remote-deployment.ts); the
 * local-host path uses `pushify/<slug>` (workers/deployment.worker.ts). Anything that meters
 * or reclaims a project's images has to recognise both — the storage meter only knew the slash
 * form, so every server-deployed project measured 0 GB and its images survived project deletion.
 */
export function projectImageRepos(slug: string): string[] {
  return [`pushify/${slug}`, `pushify-${slug}`];
}

/** The repo itself or one of its preview builds — never a sibling slug that shares a prefix. */
export function imageRepoBelongsTo(repo: string, repos: string[]): boolean {
  return repos.some((base) => repo === base || repo.startsWith(`${base}-pr-`));
}

/** `docker images --filter=reference=` patterns for the project image and its previews. */
export function projectImageReferenceFilters(slug: string): string[] {
  return projectImageRepos(slug).flatMap((base) => [base, `${base}-pr-*`]);
}
