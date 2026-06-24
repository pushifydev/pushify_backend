import type { Context, Next } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { organizationRepository } from '../repositories/organization.repository';
import { t, type SupportedLocale } from '../i18n';

export type OrgRole = 'owner' | 'admin' | 'member' | 'viewer';

/**
 * Require the authenticated user to hold one of the given roles in the current organization.
 * Use after authMiddleware (which sets userId/organizationId). Gates privileged actions
 * (e.g. billing, destructive writes) so a lower-privileged member cannot perform them.
 */
export function requireOrgRole(...roles: OrgRole[]) {
  return async (c: Context, next: Next) => {
    const locale: SupportedLocale = c.get('locale') || 'en';
    const userId = c.get('userId');
    const organizationId = c.get('organizationId');

    if (!userId || !organizationId) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !roles.includes(membership.role as OrgRole)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    await next();
  };
}
