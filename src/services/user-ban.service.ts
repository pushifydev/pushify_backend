import { HTTPException } from 'hono/http-exception';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../db';
import { users } from '../db/schema/users';
import { organizationMembers } from '../db/schema/organizations';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { apiKeys } from '../db/schema/apikeys';
import { abuseActions, bannedIdentifiers } from '../db/schema/abuse';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { forgetBanCache, identifiersFor } from '../lib/user-ban';
import { sendAccountBannedEmail, sendAccountReinstatedEmail } from '../lib/email';
import { userRepository } from '../repositories/user.repository';
import { abuseService, AUP_CLAUSES, type AupClause } from './abuse.service';
import { adminNotify } from './admin-notify.service';

/**
 * Banning an account under the Acceptable Use Policy. One action, in this order:
 *   1. mark the user banned (sign-in, refresh, API keys and shells are refused from here on)
 *   2. delete every session and API key
 *   3. record the email (normalized), GitHub and Google ids so they cannot sign up again
 *   4. suspend every project in workspaces the user owns, and power off their managed servers
 *      (stopped, never deleted; `account_banned` is not a non-payment reason, so nothing deletes them)
 *   5. one email to the user, the audit row, an operator notice
 * `adminUserId` null = the automatic path (ABUSE_AUTO_BAN_AFTER).
 */
export const userBanService = {
  async banUser(input: { userId: string; adminUserId: string | null; reason: string; clause: AupClause }) {
    const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
    if (!user) throw new HTTPException(404, { message: 'User not found' });
    if (user.bannedAt) throw new HTTPException(409, { message: 'User is already banned' });
    if (input.adminUserId && input.adminUserId === user.id) {
      throw new HTTPException(400, { message: 'You cannot ban your own account' });
    }

    const now = new Date();
    await db.update(users).set({ bannedAt: now, banReason: input.reason, updatedAt: now }).where(eq(users.id, user.id));
    forgetBanCache(user.id);

    await userRepository.deleteAllSessions(user.id);
    const keys = await db.delete(apiKeys).where(eq(apiKeys.userId, user.id)).returning({ id: apiKeys.id });

    const ids = identifiersFor({ email: user.email, githubId: user.githubId, googleId: user.googleId });
    if (ids.length) {
      await db
        .insert(bannedIdentifiers)
        .values(ids.map((i) => ({ ...i, userId: user.id, reason: input.reason, createdBy: input.adminUserId })))
        .onConflictDoNothing();
    }

    // Workspaces the user owns: their projects stop and their managed servers power off
    const owned = await db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.userId, user.id), eq(organizationMembers.role, 'owner')));
    const orgIds = owned.map((o) => o.organizationId);

    let projectsSuspended = 0;
    let serversStopped = 0;
    if (orgIds.length) {
      const toSuspend = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(inArray(projects.organizationId, orgIds), ne(projects.status, 'deleted'), isNull(projects.suspendedAt)));
      for (const p of toSuspend) {
        try {
          await abuseService.suspendProject({
            projectId: p.id,
            adminUserId: input.adminUserId,
            reason: input.reason,
            clause: input.clause,
            endsAt: null,
            notifyOwner: false,
          });
          projectsSuspended++;
        } catch (err) {
          logger.error({ err, projectId: p.id, userId: user.id }, 'Ban: could not suspend project');
        }
      }

      const { stopManagedServerForBillingSuspension } = await import('./organization-billing.service');
      const running = await db
        .select({ id: servers.id, organizationId: servers.organizationId })
        .from(servers)
        .where(and(inArray(servers.organizationId, orgIds), eq(servers.isManaged, true), inArray(servers.status, ['running', 'rebooting'])));
      for (const s of running) {
        try {
          if (await stopManagedServerForBillingSuspension(s.id, s.organizationId, 'account_banned')) serversStopped++;
        } catch (err) {
          logger.error({ err, serverId: s.id, userId: user.id }, 'Ban: could not stop managed server');
        }
      }
    }

    await db.insert(abuseActions).values({
      userId: user.id,
      adminUserId: input.adminUserId,
      action: 'ban',
      reason: input.reason,
      clause: input.clause,
    });

    await sendAccountBannedEmail(user.email, {
      reason: input.reason,
      clause: AUP_CLAUSES[input.clause],
      appealEmail: env.ABUSE_CONTACT_EMAIL,
    });
    adminNotify('user.banned', {
      user: user.email,
      automatic: input.adminUserId === null ? 'yes' : 'no',
      projectsSuspended,
      serversStopped,
      reason: input.reason,
    });
    logger.warn({ userId: user.id, projectsSuspended, serversStopped, automatic: input.adminUserId === null }, 'User banned (Acceptable Use)');

    return { projectsSuspended, serversStopped, apiKeysDeleted: keys.length, identifiersBlocked: ids.length };
  },

  /**
   * Lift a ban: the user can sign in and sign up identifiers are released. Suspended projects and
   * stopped servers stay as they are — each is reviewed and restarted on its own.
   */
  async unbanUser(input: { userId: string; adminUserId: string; note: string | null }) {
    const [user] = await db.select().from(users).where(eq(users.id, input.userId)).limit(1);
    if (!user) throw new HTTPException(404, { message: 'User not found' });
    if (!user.bannedAt) throw new HTTPException(409, { message: 'User is not banned' });

    await db.update(users).set({ bannedAt: null, banReason: null, updatedAt: new Date() }).where(eq(users.id, user.id));
    forgetBanCache(user.id);
    await db.delete(bannedIdentifiers).where(eq(bannedIdentifiers.userId, user.id));
    await db.insert(abuseActions).values({ userId: user.id, adminUserId: input.adminUserId, action: 'unban', reason: input.note });
    await sendAccountReinstatedEmail(user.email, input.note);
    return { ok: true };
  },

  /**
   * ABUSE_AUTO_BAN_AFTER (0 = off): after an automatic suspension, ban the owner of the project's
   * workspace once that many projects in workspaces they own have been suspended.
   */
  async maybeAutoBan(projectId: string): Promise<boolean> {
    const threshold = env.ABUSE_AUTO_BAN_AFTER;
    if (!threshold || threshold < 1) return false;
    const [project] = await db.select({ organizationId: projects.organizationId }).from(projects).where(eq(projects.id, projectId)).limit(1);
    if (!project) return false;
    const [owner] = await db
      .select({ userId: organizationMembers.userId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.organizationId, project.organizationId), eq(organizationMembers.role, 'owner')))
      .limit(1);
    if (!owner) return false;
    const [{ n }] = await db
      .select({ n: sql<number>`count(distinct ${abuseActions.projectId})::int` })
      .from(abuseActions)
      .innerJoin(projects, eq(projects.id, abuseActions.projectId))
      .innerJoin(
        organizationMembers,
        and(eq(organizationMembers.organizationId, projects.organizationId), eq(organizationMembers.role, 'owner')),
      )
      .where(and(eq(abuseActions.action, 'suspend'), eq(organizationMembers.userId, owner.userId)));
    if (n < threshold) return false;
    const [user] = await db.select({ bannedAt: users.bannedAt }).from(users).where(eq(users.id, owner.userId)).limit(1);
    if (!user || user.bannedAt) return false;
    await this.banUser({
      userId: owner.userId,
      adminUserId: null,
      reason: `Automatic: ${n} projects in this account were suspended under the Acceptable Use Policy.`,
      clause: 'proxy-vpn',
    });
    return true;
  },
};
