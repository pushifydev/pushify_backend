import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { organizationRepository } from '../repositories/organization.repository';
import { assertMemberProjectScope } from './member-project-scope';
import { t, type SupportedLocale } from '../i18n';

/**
 * One place for "may this person do this in this organization". Roles are ordered
 * viewer < member < admin < owner; a check names the lowest role that may pass.
 *
 * - viewer: reads that expose nothing secret.
 * - member: builds and runs apps in the projects they can see.
 * - admin: infrastructure, databases, billing actions, people.
 * - owner: everything, plus SSO, billing email and deleting the organization.
 *
 * Applies to dashboard sessions and API keys alike (a key acts as the member who created it).
 */

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

export const ROLE_RANK: Record<OrgRole, number> = { viewer: 0, member: 1, admin: 2, owner: 3 };

export function roleAtLeast(role: string | null | undefined, min: OrgRole): boolean {
  return !!role && role in ROLE_RANK && ROLE_RANK[role as OrgRole] >= ROLE_RANK[min];
}

type Membership = NonNullable<Awaited<ReturnType<typeof organizationRepository.findMember>>>;

/** The caller's membership, if their role is at least `min`; 403 otherwise (also for non-members). */
export async function requireOrgMember(
  organizationId: string,
  userId: string,
  min: OrgRole,
  locale: SupportedLocale = 'en',
): Promise<Membership> {
  const membership = organizationId && userId ? await organizationRepository.findMember(organizationId, userId) : null;
  if (!membership) throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
  if (!roleAtLeast(membership.role, min)) throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
  return membership;
}

/**
 * A project of this organization that the caller may act on with at least `min`: 404 when it is
 * not in the organization or outside a restricted member's projects (so it cannot be probed),
 * 403 when the role is too low.
 */
export async function requireProjectMember(
  projectId: string,
  organizationId: string,
  userId: string,
  min: OrgRole,
  locale: SupportedLocale = 'en',
) {
  const membership = await requireOrgMember(organizationId, userId, 'viewer', locale);
  const [project] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.organizationId, organizationId)))
    .limit(1);
  if (!project) throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
  await assertMemberProjectScope(membership, organizationId, userId, projectId, locale);
  if (!roleAtLeast(membership.role, min)) throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
  return { membership, project };
}

/** Route middleware form of requireOrgMember, for routers without a service-level check. */
export function requireMinRole(min: OrgRole) {
  return async (c: Context, next: Next) => {
    await requireOrgMember(c.get('organizationId') ?? '', c.get('userId') ?? '', min, c.get('locale') || 'en');
    await next();
  };
}
