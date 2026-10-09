import { and, eq, inArray, ne, or, sql, isNull } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { projectWorkers } from '../db/schema/project-workers';
import { projectVolumes } from '../db/schema/project-volumes';
import { pickRunnerServerId } from './runner-routing';
import { volumeDockerName } from './volume-validate';

/**
 * Exact names of a project's containers. Shared runners host many organizations, and project
 * slugs are only unique within an organization — so "every container starting with
 * pushify-<slug>-" also matches `pushify-<slug>-store-blue`, someone else's app. Everything that
 * stops, starts, removes or attaches to a project's containers must use these patterns.
 *
 *   app       pushify-<slug>[-staging|-pr-N][-blue|-green][-<replica>]
 *   preview   pushify-preview-<slug>-pr-N
 *   database  pushify-<slug>-db
 *   workers   pushify-<slug>[-staging]-worker-<name>, for the project's own worker names only
 */

const SLUG_RE = /^[a-z0-9-]+$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function assertSafeSlug(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`Unsafe project slug: ${slug}`);
  return slug;
}

/** The app's own containers (production, staging, PR previews; blue/green; replicas). */
export function appContainerPattern(slug: string): string {
  const s = escapeRe(assertSafeSlug(slug));
  return `^pushify-${s}(-staging|-pr-[0-9]+)?(-(blue|green)(-[0-9]+)?)?$`;
}

/** Every container that belongs to the project, given its worker names. ERE, for `grep -E`. */
export function projectContainerPattern(slug: string, workerNames: string[] = []): string {
  const s = escapeRe(assertSafeSlug(slug));
  const parts = [appContainerPattern(slug), `^pushify-preview-${s}-pr-[0-9]+$`, `^pushify-${s}-db$`];
  const workers = workerNames.filter((w) => SLUG_RE.test(w)).map(escapeRe);
  if (workers.length) parts.push(`^pushify-${s}(-staging)?-worker-(${workers.join('|')})$`);
  return parts.join('|');
}

/**
 * Whether two slugs can name each other's containers or files on one host: the same slug, or one
 * is the other plus a suffix the deployer itself appends (-staging, -pr-N, -db, -worker-…).
 */
export function slugsConflict(a: string, b: string): boolean {
  if (a === b) return true;
  const suffix = /^-(staging|db|pr-[0-9]+|worker-.+)$/;
  return (b.startsWith(`${a}-`) && suffix.test(b.slice(a.length))) || (a.startsWith(`${b}-`) && suffix.test(a.slice(b.length)));
}

export interface ProjectContainerNames {
  workers: string[];
  volumes: string[];
}

/** The project's worker names and exact volume names, from the database. */
export async function projectContainerNames(projectId: string, slug: string): Promise<ProjectContainerNames> {
  const [workers, volumes] = await Promise.all([
    db.select({ name: projectWorkers.name }).from(projectWorkers).where(eq(projectWorkers.projectId, projectId)),
    db.select({ name: projectVolumes.name }).from(projectVolumes).where(eq(projectVolumes.projectId, projectId)),
  ]);
  return {
    workers: workers.map((w) => w.name),
    volumes: volumes.map((v) => volumeDockerName(slug, v.name)),
  };
}

/**
 * Other projects on the same shared runner whose slug conflicts with this one (see
 * slugsConflict). Empty for projects on their own server: a server belongs to one organization.
 */
export async function runnerSlugConflicts(
  project: { id: string; slug: string; serverId: string | null },
  opts: { activeOnly?: boolean } = {},
): Promise<{ id: string; slug: string; organizationId: string; status: string }[]> {
  if (project.serverId) return [];
  const runnerId = pickRunnerServerId(project.id);
  if (!runnerId) return [];
  const slug = project.slug;
  const candidates = await db
    .select({ id: projects.id, slug: projects.slug, organizationId: projects.organizationId, status: projects.status })
    .from(projects)
    .where(
      and(
        isNull(projects.serverId),
        ne(projects.id, project.id),
        opts.activeOnly ? eq(projects.status, 'active') : inArray(projects.status, ['active', 'paused']),
        or(
          eq(projects.slug, slug),
          sql`${projects.slug} LIKE ${`${slug}-%`}`,
          sql`${slug} LIKE ${projects.slug} || '-%'`,
        ),
      ),
    );
  return candidates.filter((c) => slugsConflict(slug, c.slug) && pickRunnerServerId(c.id) === runnerId);
}
