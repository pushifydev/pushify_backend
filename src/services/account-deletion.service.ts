import { HTTPException } from 'hono/http-exception';
import { and, count, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { db } from '../db';
import {
  apiKeys,
  gitIntegrations,
  organizationMembers,
  organizations,
  projects,
  purchasedDomains,
  servers,
  users,
} from '../db/schema';
import { t, type SupportedLocale } from '../i18n';
import { logger } from '../lib/logger';
import { verifyPassword } from '../lib/password';
import { invalidateDeletionLock } from '../lib/deletion-lock';
import {
  generateAccountRestoreToken,
  generateDeletionConfirmToken,
  verifyAccountRestoreToken,
  verifyDeletionConfirmToken,
} from '../lib/jwt';
import { getOptionalRedis } from '../lib/redis-client';
import { env } from '../config/env';
import { pauseProjectContainers } from '../lib/project-remote-cleanup';
import { sendDeletionConfirmEmail, sendDeletionRestoredEmail, sendDeletionScheduledEmail } from '../lib/email';
import { resolveBillingNotifyEmail } from '../lib/billing-notify';
import { projectRepository } from '../repositories/project.repository';
import { userRepository } from '../repositories/user.repository';
import { stopManagedServerForBillingSuspension } from './organization-billing.service';
import { includedCreditService } from './included-credit.service';
import { revokePushifyAccess } from './server.service';
import { stripeService } from './stripe.service';
import { twoFactorService } from './twoFactor.service';

/**
 * Deleting an organization or an account (Privacy Policy §4).
 *
 * A request locks everything at once — sessions, API keys, the subscription, managed servers,
 * Pushify's access to connected servers — and schedules a permanent purge 30 days later. Until
 * then the owner can restore it. The purge itself is a separate worker.
 *
 * Connected (BYOS) servers belong to the user: their apps keep running. Pushify's SSH key is taken
 * off, and the credentials we stored for them are wiped, so we cannot reach them any more; a
 * restore means connecting them again.
 */

export const DELETION_GRACE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Marks why a managed server is powered off (vs. billing). */
export const DELETION_STATUS_MESSAGE = 'deletion_scheduled';

export function deletionDueDate(now: Date = new Date()): Date {
  return new Date(now.getTime() + DELETION_GRACE_DAYS * DAY_MS);
}

export interface ServerAccessOutcome {
  serverId: string;
  name: string;
  host: string | null;
  keyRemoved: boolean;
  /** Run as root on the server when Pushify could not remove its key */
  manualCommand: string | null;
}

export interface DeletionScheduled {
  scheduledFor: Date;
  servers: ServerAccessOutcome[];
  walletBalanceCents: number;
}

export interface DeletionCredentials {
  password?: string;
  twoFactorCode?: string;
}

/** Returned instead of a schedule when the request must first be confirmed from the inbox. */
export interface DeletionConfirmationSent {
  confirmationSent: true;
}

interface RequestOptions {
  /** Set when the request comes back through the emailed link */
  confirmedByEmail?: boolean;
}

/** An account with neither a password nor 2FA has nothing to re-enter: it confirms by email. */
function confirmsByEmail(user: { passwordHash: string | null; twoFactorEnabled: boolean }): boolean {
  return !user.passwordHash && !user.twoFactorEnabled;
}

async function sendConfirmation(
  user: { id: string; email: string },
  kind: 'organization' | 'account',
  name: string,
  locale: SupportedLocale,
  organizationId?: string,
): Promise<DeletionConfirmationSent> {
  const token = await generateDeletionConfirmToken(user.id, kind, organizationId);
  const confirmUrl = `${env.FRONTEND_URL}/confirm-deletion#token=${encodeURIComponent(token)}`;
  await sendDeletionConfirmEmail(user.email, { kind, name, confirmUrl }, locale === 'tr' ? 'tr' : 'en');
  logger.info({ userId: user.id, kind, organizationId }, 'deletion confirmation link sent');
  return { confirmationSent: true };
}

/** A confirmation link works once: its id is claimed for as long as the link could be valid. */
const claimedLinks = new Map<string, number>();
async function claimLink(jti: string): Promise<boolean> {
  const redis = getOptionalRedis();
  if (redis) {
    try {
      return (await redis.set(`deletion-confirm:${jti}`, '1', 'EX', 3600, 'NX')) === 'OK';
    } catch (err) {
      logger.warn({ err }, 'deletion confirm: Redis unavailable, using process memory');
    }
  }
  const now = Date.now();
  for (const [k, exp] of claimedLinks) if (exp < now) claimedLinks.delete(k);
  if (claimedLinks.has(jti)) return false;
  claimedLinks.set(jti, now + 3600_000);
  return true;
}

/**
 * Re-authentication before a deletion: the password when the account has one, and a 2FA code when
 * 2FA is on. An account with neither confirms from its inbox instead (sendConfirmation).
 */
async function verifyIdentity(userId: string, credentials: DeletionCredentials, locale: SupportedLocale): Promise<void> {
  const user = await userRepository.findById(userId);
  if (!user) throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
  if (user.passwordHash) {
    const password = credentials.password ?? '';
    if (!password || !(await verifyPassword(user.passwordHash, password))) {
      throw new HTTPException(400, { message: t(locale, 'auth', 'invalidPassword') });
    }
  }
  if (user.twoFactorEnabled) {
    const code = credentials.twoFactorCode?.trim() ?? '';
    const valid =
      !!code &&
      ((code.length === 6 && (await twoFactorService.verifyCode(userId, code, locale))) ||
        (await twoFactorService.verifyBackupCode(userId, code, locale)));
    if (!valid) throw new HTTPException(400, { message: t(locale, 'twoFactor', 'invalidCode') });
  }
}

async function assertOwner(organizationId: string, userId: string, locale: SupportedLocale): Promise<void> {
  const [member] = await db
    .select({ role: organizationMembers.role })
    .from(organizationMembers)
    .where(and(eq(organizationMembers.organizationId, organizationId), eq(organizationMembers.userId, userId)))
    .limit(1);
  if (member?.role !== 'owner') throw new HTTPException(403, { message: t(locale, 'deletion', 'ownerOnly') });
}

/** Stop shared-runner projects, power off managed servers, cut Pushify off connected ones. */
async function lockInfrastructure(organizationId: string): Promise<ServerAccessOutcome[]> {
  const orgServers = await db.select().from(servers).where(eq(servers.organizationId, organizationId));
  const connectedIds = new Set(orgServers.filter((s) => !s.isManaged).map((s) => s.id));

  // Projects on Pushify's shared runners or on managed servers go offline. Projects on a server
  // the user owns keep running there — it is their machine.
  const activeProjects = await db
    .select()
    .from(projects)
    .where(and(eq(projects.organizationId, organizationId), eq(projects.status, 'active')));
  for (const project of activeProjects) {
    if (project.serverId && connectedIds.has(project.serverId)) continue;
    try {
      await pauseProjectContainers(project);
    } catch (err) {
      logger.warn({ err, projectId: project.id, organizationId }, 'deletion: could not pause project containers');
    }
    await projectRepository.updateStatus(project.id, 'paused');
  }

  for (const server of orgServers) {
    if (server.isManaged && ['running', 'rebooting'].includes(server.status)) {
      await stopManagedServerForBillingSuspension(server.id, organizationId, DELETION_STATUS_MESSAGE);
    }
  }

  const outcomes: ServerAccessOutcome[] = [];
  for (const server of orgServers.filter((s) => !s.isManaged)) {
    const result = await revokePushifyAccess(server);
    // Whatever happened on the machine, we keep no way back in: the stored key or password goes.
    await db
      .update(servers)
      .set({
        sshPrivateKey: null,
        rootPassword: null,
        setupStatus: 'pending',
        statusMessage: DELETION_STATUS_MESSAGE,
        updatedAt: new Date(),
      })
      .where(eq(servers.id, server.id));
    if (result) {
      outcomes.push({
        serverId: server.id,
        name: server.name,
        host: server.ipv4,
        keyRemoved: result.keyRemoved,
        manualCommand: result.keyRemoved ? null : (result.manualCommand ?? null),
      });
    }
  }
  return outcomes;
}

/**
 * Lock one organization and schedule its purge. The subscription is cancelled first: if Stripe
 * cannot be reached nothing has changed yet and the request can simply be retried.
 */
async function scheduleOrganization(
  organizationId: string,
  requestedBy: string,
  now: Date,
  locale: SupportedLocale,
): Promise<DeletionScheduled> {
  await stripeService.cancelSubscriptionForDeletion(organizationId);

  const scheduledFor = deletionDueDate(now);
  const [marked] = await db
    .update(organizations)
    .set({ deletionRequestedAt: now, deletionScheduledFor: scheduledFor, deletionRequestedBy: requestedBy, updatedAt: now })
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deletionScheduledFor)))
    .returning();
  if (!marked) throw new HTTPException(409, { message: t(locale, 'deletion', 'alreadyScheduled') });
  invalidateDeletionLock(organizationId);

  await db.delete(apiKeys).where(eq(apiKeys.organizationId, organizationId));
  await includedCreditService.expire(organizationId, 'canceled').catch((err) => {
    logger.warn({ err, organizationId }, 'deletion: could not expire included credit');
  });
  await db
    .update(purchasedDomains)
    .set({ autoRenew: false, updatedAt: now })
    .where(eq(purchasedDomains.organizationId, organizationId));

  const serverOutcomes = await lockInfrastructure(organizationId);
  logger.info({ organizationId, scheduledFor: scheduledFor.toISOString() }, 'organization deletion scheduled');
  return { scheduledFor, servers: serverOutcomes, walletBalanceCents: marked.infraWalletBalanceCents };
}

function manualRemovals(outcomes: ServerAccessOutcome[]) {
  return outcomes.filter((o) => o.manualCommand).map((o) => ({ server: o.name, command: o.manualCommand! }));
}

async function clearOrganizationDeletion(organizationId: string): Promise<boolean> {
  const [restored] = await db
    .update(organizations)
    // The deletion cancelled any subscription, so a restored organization starts on Free, unlocked.
    .set({
      deletionRequestedAt: null,
      deletionScheduledFor: null,
      deletionRequestedBy: null,
      billingStatus: 'active',
      updatedAt: new Date(),
    })
    .where(and(eq(organizations.id, organizationId), isNotNull(organizations.deletionScheduledFor)))
    .returning({ id: organizations.id });
  invalidateDeletionLock(organizationId);
  return !!restored;
}

export const accountDeletionService = {
  /** What the confirmation dialog shows before an organization is deleted. */
  async organizationPreview(organizationId: string, userId: string, locale: SupportedLocale) {
    await assertOwner(organizationId, userId, locale);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    if (!org) throw new HTTPException(404, { message: t(locale, 'errors', 'notFound') });
    const orgServers = await db
      .select({ id: servers.id, name: servers.name, isManaged: servers.isManaged })
      .from(servers)
      .where(eq(servers.organizationId, organizationId));
    const domains = await db
      .select({ domainName: purchasedDomains.domainName, expiresAt: purchasedDomains.expiresAt })
      .from(purchasedDomains)
      .where(eq(purchasedDomains.organizationId, organizationId));
    return {
      name: org.name,
      plan: org.plan,
      hasSubscription: !!org.stripeSubscriptionId,
      walletBalanceCents: org.infraWalletBalanceCents,
      includedCreditCents: org.includedCreditCents,
      managedServers: orgServers.filter((s) => s.isManaged).map((s) => ({ id: s.id, name: s.name })),
      connectedServers: orgServers.filter((s) => !s.isManaged).map((s) => ({ id: s.id, name: s.name })),
      domains,
      graceDays: DELETION_GRACE_DAYS,
      deletionScheduledFor: org.deletionScheduledFor,
    };
  },

  async requestOrganizationDeletion(
    organizationId: string,
    userId: string,
    input: DeletionCredentials & { confirmName: string },
    locale: SupportedLocale,
    now: Date = new Date(),
    opts: RequestOptions = {},
  ): Promise<DeletionScheduled | DeletionConfirmationSent> {
    await assertOwner(organizationId, userId, locale);
    const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
    if (!org) throw new HTTPException(404, { message: t(locale, 'errors', 'notFound') });
    if (org.deletionScheduledFor) throw new HTTPException(409, { message: t(locale, 'deletion', 'alreadyScheduled') });
    if (input.confirmName.trim() !== org.name) {
      throw new HTTPException(400, { message: t(locale, 'deletion', 'confirmMismatch') });
    }
    if (!opts.confirmedByEmail) {
      const user = await userRepository.findById(userId);
      if (!user) throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
      if (confirmsByEmail(user)) return sendConfirmation(user, 'organization', org.name, locale, organizationId);
      await verifyIdentity(userId, input, locale);
    }

    const result = await scheduleOrganization(organizationId, userId, now, locale);
    const to = (await resolveBillingNotifyEmail(organizationId)) ?? (await userRepository.findById(userId))?.email;
    if (to) {
      await sendDeletionScheduledEmail(
        to,
        {
          kind: 'organization',
          name: org.name,
          scheduledFor: result.scheduledFor,
          manualKeyRemovals: manualRemovals(result.servers),
          walletBalanceCents: result.walletBalanceCents,
        },
        locale === 'tr' ? 'tr' : 'en',
      );
    }
    return result;
  },

  async restoreOrganization(organizationId: string, userId: string, locale: SupportedLocale): Promise<void> {
    await assertOwner(organizationId, userId, locale);
    const [org] = await db
      .select({ name: organizations.name })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (!(await clearOrganizationDeletion(organizationId))) {
      throw new HTTPException(409, { message: t(locale, 'deletion', 'notScheduled') });
    }
    logger.info({ organizationId, userId }, 'organization deletion cancelled');
    const to = (await resolveBillingNotifyEmail(organizationId)) ?? (await userRepository.findById(userId))?.email;
    if (to && org) await sendDeletionRestoredEmail(to, { kind: 'organization', name: org.name }, locale === 'tr' ? 'tr' : 'en');
  },

  /**
   * Delete the signed-in user's account. Organizations they own go with it; one that has other
   * members blocks the request (there is no ownership transfer yet).
   */
  async requestAccountDeletion(
    userId: string,
    input: DeletionCredentials & { confirmEmail: string },
    locale: SupportedLocale,
    now: Date = new Date(),
    opts: RequestOptions = {},
  ): Promise<(DeletionScheduled & { organizations: string[] }) | DeletionConfirmationSent> {
    const user = await userRepository.findById(userId);
    if (!user) throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
    if (user.deletionScheduledFor) throw new HTTPException(409, { message: t(locale, 'deletion', 'alreadyScheduled') });
    if (input.confirmEmail.trim().toLowerCase() !== user.email.toLowerCase()) {
      throw new HTTPException(400, { message: t(locale, 'deletion', 'confirmMismatch') });
    }

    const owned = await db
      .select({ organizationId: organizationMembers.organizationId })
      .from(organizationMembers)
      .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.role, 'owner')));
    const ownedIds = owned.map((o) => o.organizationId);
    if (ownedIds.length > 0) {
      const memberCounts = await db
        .select({ organizationId: organizationMembers.organizationId, n: count() })
        .from(organizationMembers)
        .where(inArray(organizationMembers.organizationId, ownedIds))
        .groupBy(organizationMembers.organizationId);
      if (memberCounts.some((m) => Number(m.n) > 1)) {
        throw new HTTPException(409, { message: t(locale, 'deletion', 'orgHasMembers') });
      }
    }
    if (!opts.confirmedByEmail) {
      if (confirmsByEmail(user)) return sendConfirmation(user, 'account', user.email, locale);
      await verifyIdentity(userId, input, locale);
    }

    const toSchedule = ownedIds.length
      ? await db
          .select({ id: organizations.id, name: organizations.name })
          .from(organizations)
          .where(and(inArray(organizations.id, ownedIds), isNull(organizations.deletionScheduledFor)))
      : [];
    const allServers: ServerAccessOutcome[] = [];
    let walletBalanceCents = 0;
    for (const org of toSchedule) {
      const r = await scheduleOrganization(org.id, userId, now, locale);
      allServers.push(...r.servers);
      walletBalanceCents += r.walletBalanceCents;
    }

    const scheduledFor = deletionDueDate(now);
    const [marked] = await db
      .update(users)
      .set({ deletionRequestedAt: now, deletionScheduledFor: scheduledFor, updatedAt: now })
      .where(and(eq(users.id, userId), isNull(users.deletionScheduledFor)))
      .returning({ id: users.id });
    if (!marked) throw new HTTPException(409, { message: t(locale, 'deletion', 'alreadyScheduled') });

    // Signed out everywhere; keys and git tokens are revoked now, not at the purge.
    await userRepository.deleteAllSessions(userId);
    await db.delete(apiKeys).where(eq(apiKeys.userId, userId));
    await db.delete(gitIntegrations).where(eq(gitIntegrations.userId, userId));
    logger.info({ userId, organizations: toSchedule.map((o) => o.id) }, 'account deletion scheduled');

    await sendDeletionScheduledEmail(
      user.email,
      {
        kind: 'account',
        name: user.email,
        scheduledFor,
        manualKeyRemovals: manualRemovals(allServers),
        walletBalanceCents,
      },
      locale === 'tr' ? 'tr' : 'en',
    );
    return { scheduledFor, servers: allServers, walletBalanceCents, organizations: toSchedule.map((o) => o.name) };
  },

  /**
   * The emailed link: re-checks everything (still the owner, nothing scheduled yet) and then runs
   * the same request as the dashboard would have. One use, one hour.
   */
  async confirmDeletion(token: string, locale: SupportedLocale) {
    let payload: Awaited<ReturnType<typeof verifyDeletionConfirmToken>>;
    try {
      payload = await verifyDeletionConfirmToken(token);
    } catch {
      throw new HTTPException(401, { message: t(locale, 'deletion', 'confirmLinkInvalid') });
    }
    if (!(await claimLink(payload.jti))) {
      throw new HTTPException(409, { message: t(locale, 'deletion', 'confirmLinkUsed') });
    }
    const opts = { confirmedByEmail: true };
    if (payload.kind === 'organization') {
      const [org] = await db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, payload.org!))
        .limit(1);
      if (!org) throw new HTTPException(404, { message: t(locale, 'errors', 'notFound') });
      const result = await this.requestOrganizationDeletion(payload.org!, payload.sub, { confirmName: org.name }, locale, new Date(), opts);
      return { kind: 'organization' as const, ...result };
    }
    const user = await userRepository.findById(payload.sub);
    if (!user) throw new HTTPException(404, { message: t(locale, 'auth', 'userNotFound') });
    const result = await this.requestAccountDeletion(payload.sub, { confirmEmail: user.email }, locale, new Date(), opts);
    return { kind: 'account' as const, ...result };
  },

  /**
   * Restore an account from the token handed out when a pending account tries to sign in. The
   * organizations that were scheduled along with it are restored too.
   */
  async restoreAccount(restoreToken: string, locale: SupportedLocale): Promise<void> {
    let userId: string;
    try {
      userId = (await verifyAccountRestoreToken(restoreToken)).sub;
    } catch {
      throw new HTTPException(401, { message: t(locale, 'deletion', 'restoreTokenInvalid') });
    }
    const [pending] = await db
      .select({ requestedAt: users.deletionRequestedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const [restored] = await db
      .update(users)
      .set({ deletionRequestedAt: null, deletionScheduledFor: null, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNotNull(users.deletionScheduledFor)))
      .returning({ email: users.email });
    if (!restored || !pending?.requestedAt) throw new HTTPException(409, { message: t(locale, 'deletion', 'notScheduled') });

    // Only the organizations scheduled by this same request (an organization deleted on its own
    // earlier stays scheduled).
    const withIt = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(
        and(
          eq(organizations.deletionRequestedBy, userId),
          eq(organizations.deletionRequestedAt, pending.requestedAt),
          isNotNull(organizations.deletionScheduledFor),
        ),
      );
    for (const org of withIt) await clearOrganizationDeletion(org.id);
    logger.info({ userId, organizations: withIt.map((o) => o.id) }, 'account deletion cancelled');
    await sendDeletionRestoredEmail(restored.email, { kind: 'account', name: restored.email }, locale === 'tr' ? 'tr' : 'en');
  },

  /** Thrown by sign-in for an account waiting to be deleted; carries a short-lived restore token. */
  async pendingAccountError(user: { id: string; deletionScheduledFor: Date }, locale: SupportedLocale): Promise<HTTPException> {
    return new HTTPException(403, {
      message: t(locale, 'deletion', 'accountPending'),
      cause: {
        code: 'ACCOUNT_PENDING_DELETION',
        details: {
          scheduledFor: user.deletionScheduledFor.toISOString(),
          restoreToken: await generateAccountRestoreToken(user.id),
        },
      },
    });
  },
};
