import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { memberProjectAccess } from '../db/schema/organizations';
import { t, type SupportedLocale } from '../i18n';
import { currentApiKeyProjectIds } from './api-key-project-scope';

export type MembershipScope = {
  role: string;
  restrictedAccess?: boolean | null;
};

/** Owner/admin always see every project; restriction only applies when the member row opts in */
export function memberHasFullProjectAccess(membership: MembershipScope): boolean {
  return (
    membership.role === 'owner' ||
    membership.role === 'admin' ||
    !membership.restrictedAccess
  );
}

/**
 * Returns the allowlisted project ids for a restricted member, or null for unrestricted access.
 * During a request made with a project-scoped API key the result is also limited to the key's
 * projects (lib/api-key-project-scope), whatever the creator's role.
 */
export async function getMemberAllowedProjectIds(
  membership: MembershipScope,
  organizationId: string,
  userId: string
): Promise<string[] | null> {
  const memberIds = await getMemberOwnAllowedProjectIds(membership, organizationId, userId);
  const keyIds = currentApiKeyProjectIds();
  if (!keyIds) return memberIds;
  if (!memberIds) return [...keyIds];
  return memberIds.filter((id) => keyIds.includes(id.toLowerCase()));
}

async function getMemberOwnAllowedProjectIds(
  membership: MembershipScope,
  organizationId: string,
  userId: string
): Promise<string[] | null> {
  if (memberHasFullProjectAccess(membership)) return null;

  const rows = await db
    .select({ projectId: memberProjectAccess.projectId })
    .from(memberProjectAccess)
    .where(
      and(
        eq(memberProjectAccess.organizationId, organizationId),
        eq(memberProjectAccess.userId, userId)
      )
    );

  return rows.map((row) => row.projectId);
}

export async function memberCanAccessProject(
  membership: MembershipScope,
  organizationId: string,
  userId: string,
  projectId: string
): Promise<boolean> {
  const keyIds = currentApiKeyProjectIds();
  if (keyIds && !keyIds.includes(projectId.toLowerCase())) return false;

  if (memberHasFullProjectAccess(membership)) return true;

  const row = await db.query.memberProjectAccess.findFirst({
    where: and(
      eq(memberProjectAccess.organizationId, organizationId),
      eq(memberProjectAccess.userId, userId),
      eq(memberProjectAccess.projectId, projectId)
    ),
  });

  return !!row;
}

/** Throws the same 404 as an org mismatch so restricted members cannot probe project existence */
export async function assertMemberProjectScope(
  membership: MembershipScope,
  organizationId: string,
  userId: string,
  projectId: string,
  locale: SupportedLocale = 'en'
): Promise<void> {
  if (!(await memberCanAccessProject(membership, organizationId, userId, projectId))) {
    throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
  }
}
