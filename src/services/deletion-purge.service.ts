import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../db';
import {
  authEvents,
  deletedOrganizations,
  deletionPurgeSteps,
  domains,
  githubAppInstallations,
  gitIntegrations,
  infraWalletTransactions,
  organizationMembers,
  organizations,
  projects,
  purchasedDomains,
  servers,
  users,
} from '../db/schema';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { decrypt } from '../lib/encryption';
import { getStripe } from '../lib/stripe';
import { getRegistrar } from '../lib/registrar';
import { getApiBaseUrl } from '../lib/api-base-url';
import { createProvider, type ProviderType } from '../providers';
import { resolveBillingNotifyEmail } from '../lib/billing-notify';
import { sendDeletionCompletedEmail, sendDeletionReminderEmail } from '../lib/email';

/**
 * The permanent half of a deletion (Privacy Policy §4): once `deletion_scheduled_for` has passed,
 * an organization's external resources are removed first and its row last, so a failure never
 * leaves something outside our database that nothing points at any more.
 *
 * Each step is recorded in `deletion_purge_steps`. A required step that fails is retried on the
 * next sweep (and the admin is told after a few attempts); a best-effort step — someone else's
 * GitHub repository, the registrar's email forwards — is recorded and skipped, because a revoked
 * token must not keep a deletion from ever completing.
 */

const REMINDER_DAYS_BEFORE = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const ALERT_AFTER_ATTEMPTS = 3;

type StepResult = void;
interface Step {
  name: string;
  required: boolean;
  run: () => Promise<StepResult>;
}

function providerToken(provider: ProviderType): string {
  switch (provider) {
    case 'hetzner':
      return env.HETZNER_API_TOKEN || '';
    case 'digitalocean':
      return process.env.DIGITALOCEAN_API_TOKEN || '';
    case 'aws':
      return process.env.AWS_ACCESS_KEY || '';
    default:
      return '';
  }
}

const isNotFound = (err: unknown) => /\b404\b|not[ _]found/i.test(err instanceof Error ? err.message : String(err));

async function stepStatus(subjectId: string, step: string) {
  const [row] = await db
    .select()
    .from(deletionPurgeSteps)
    .where(and(eq(deletionPurgeSteps.subjectId, subjectId), eq(deletionPurgeSteps.step, step)))
    .limit(1);
  return row ?? null;
}

async function recordStep(subjectId: string, step: string, status: 'done' | 'failed', error?: string): Promise<number> {
  const [row] = await db
    .insert(deletionPurgeSteps)
    .values({ subjectId, step, status, attempts: 1, lastError: error ?? null })
    .onConflictDoUpdate({
      target: [deletionPurgeSteps.subjectId, deletionPurgeSteps.step],
      set: {
        status,
        attempts: sql`${deletionPurgeSteps.attempts} + 1`,
        lastError: error ?? null,
        updatedAt: new Date(),
      },
    })
    .returning({ attempts: deletionPurgeSteps.attempts });
  return row?.attempts ?? 1;
}

/** Run steps in order; stop at the first required step that fails. True when all are settled. */
async function runSteps(subjectId: string, steps: Step[]): Promise<boolean> {
  for (const step of steps) {
    const prior = await stepStatus(subjectId, step.name);
    if (prior?.status === 'done' || (prior?.status === 'failed' && !step.required)) continue;
    try {
      await step.run();
      await recordStep(subjectId, step.name, 'done');
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      const attempts = await recordStep(subjectId, step.name, 'failed', message);
      logger.warn({ subjectId, step: step.name, attempts, err: message }, 'purge step failed');
      if (step.required) {
        if (attempts === ALERT_AFTER_ATTEMPTS) {
          const { adminNotify } = await import('./admin-notify.service');
          adminNotify('deletion.purge_stuck', { subjectId, step: step.name, error: message.slice(0, 300) });
        }
        return false;
      }
    }
  }
  return true;
}

function organizationSteps(organizationId: string): Step[] {
  return [
    {
      // Servers in Pushify's provider account: the server, the SSH key uploaded for it, and every
      // snapshot taken from it (snapshots outlive their server and keep billing).
      name: 'managed-servers',
      required: true,
      run: async () => {
        const managed = await db
          .select()
          .from(servers)
          .where(and(eq(servers.organizationId, organizationId), eq(servers.isManaged, true)));
        for (const server of managed) {
          const token = providerToken(server.provider as ProviderType);
          if (!token || !server.providerId) continue;
          const provider = createProvider(server.provider as ProviderType, token);
          const snapshotIds = provider.listSnapshotIdsCreatedFrom
            ? await provider.listSnapshotIdsCreatedFrom(server.providerId)
            : [];
          for (const id of snapshotIds) {
            await provider.deleteSnapshot(id).catch((err) => {
              if (!isNotFound(err)) throw err;
            });
          }
          await provider.deleteServer(server.providerId).catch((err) => {
            if (!isNotFound(err)) throw err;
          });
          if (server.sshKeyId) {
            await provider.deleteSSHKey(server.sshKeyId).catch((err) => {
              if (!isNotFound(err)) throw err;
            });
          }
        }
      },
    },
    {
      // Containers, images, volumes and vhosts on Pushify's shared runners. Projects on managed
      // servers went with the servers; those on the customer's own server are theirs.
      name: 'runner-projects',
      required: true,
      run: async () => {
        const onRunners = await db
          .select()
          .from(projects)
          .where(and(eq(projects.organizationId, organizationId), isNull(projects.serverId)));
        const { projectService } = await import('./project.service');
        for (const project of onRunners) {
          if (project.status === 'deleted') continue; // torn down when it was deleted
          await projectService.cleanupProjectContainers(project);
        }
      },
    },
    {
      name: 'dns',
      required: false,
      run: async () => {
        const { deleteAutoSubdomainRecord, hostnameOf } = await import('../lib/cloudflare-dns');
        const { previewRepository } = await import('../repositories/preview.repository');
        const orgProjects = await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.organizationId, organizationId));
        for (const p of orgProjects) {
          const auto = await db
            .select({ domain: domains.domain })
            .from(domains)
            .where(and(eq(domains.projectId, p.id), eq(domains.isAutoGenerated, true)));
          const previews = (await previewRepository.findAllByProject(p.id, 500))
            .map((preview) => hostnameOf(preview.previewUrl))
            .filter((h): h is string => !!h);
          for (const name of [...auto.map((d) => d.domain), ...previews]) await deleteAutoSubdomainRecord(name);
        }
      },
    },
    {
      name: 'offsite-backups',
      required: true,
      run: async () => {
        const { offsiteBackupService } = await import('./offsite-backup.service');
        await offsiteBackupService.purgeOrganization(organizationId);
      },
    },
    {
      // Pushify's webhooks in the owner's repositories, then the app installation itself.
      name: 'github',
      required: false,
      run: async () => {
        const { githubService } = await import('./github.service');
        const [owner] = await db
          .select({ accessToken: gitIntegrations.accessToken })
          .from(organizationMembers)
          .innerJoin(gitIntegrations, eq(gitIntegrations.userId, organizationMembers.userId))
          .where(
            and(
              eq(organizationMembers.organizationId, organizationId),
              eq(organizationMembers.role, 'owner'),
              eq(gitIntegrations.provider, 'github'),
            ),
          )
          .limit(1);
        if (owner) {
          const token = decrypt(owner.accessToken);
          const repos = await db
            .select({ id: projects.id, gitRepoUrl: projects.gitRepoUrl })
            .from(projects)
            .where(and(eq(projects.organizationId, organizationId), isNotNull(projects.gitRepoUrl)));
          for (const p of repos) {
            const parsed = githubService.parseRepoUrl(p.gitRepoUrl!);
            if (!parsed) continue;
            await githubService.deleteRepoWebhook(token, parsed.owner, parsed.repo, `${getApiBaseUrl()}/api/v1/webhooks/github/${p.id}`);
          }
        }
        const installs = await db
          .select({ installationId: githubAppInstallations.installationId })
          .from(githubAppInstallations)
          .where(eq(githubAppInstallations.organizationId, organizationId));
        if (installs.length) {
          const { githubAppService } = await import('./github-app.service');
          for (const i of installs) await githubAppService.uninstall(i.installationId);
        }
      },
    },
    {
      // Domains stay registered until they expire (auto-renew went off at the request) and keep
      // their DNS records, so sites on the customer's own servers keep answering until then.
      // The email forwards carry the customer's addresses, so they go.
      name: 'registrar',
      required: false,
      run: async () => {
        const registrar = getRegistrar();
        if (!registrar) return;
        const owned = await db
          .select({ domainName: purchasedDomains.domainName })
          .from(purchasedDomains)
          .where(eq(purchasedDomains.organizationId, organizationId));
        for (const d of owned) {
          const forwards = await registrar.listEmailForwardings(d.domainName);
          for (const f of forwards) await registrar.deleteEmailForwarding(d.domainName, f.emailBox);
        }
      },
    },
    {
      // Deleting the customer removes its saved cards; Stripe keeps its invoices.
      name: 'stripe',
      required: true,
      run: async () => {
        const [org] = await db
          .select({ customerId: organizations.stripeCustomerId })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .limit(1);
        if (!org?.customerId || !env.STRIPE_SECRET_KEY) return;
        const { isStripeResourceMissing } = await import('./stripe.service');
        try {
          await getStripe().customers.del(org.customerId);
        } catch (err) {
          if (!isStripeResourceMissing(err)) throw err;
        }
      },
    },
    {
      name: 'billing-record',
      required: true,
      run: async () => {
        const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId)).limit(1);
        if (!org) return;
        const ledger = await db
          .select()
          .from(infraWalletTransactions)
          .where(eq(infraWalletTransactions.organizationId, organizationId));
        const purgedAt = new Date();
        const retainUntil = new Date(purgedAt);
        retainUntil.setUTCFullYear(retainUntil.getUTCFullYear() + env.BILLING_RECORD_RETENTION_YEARS);
        await db
          .insert(deletedOrganizations)
          .values({
            id: org.id,
            name: org.name,
            billingEmail: (await resolveBillingNotifyEmail(org.id)) ?? org.billingEmail,
            stripeCustomerId: org.stripeCustomerId,
            walletLedger: ledger,
            deletionRequestedAt: org.deletionRequestedAt ?? purgedAt,
            purgedAt,
            retainUntil,
          })
          .onConflictDoNothing();
      },
    },
    {
      // Last: the row, and with it (cascade) projects, deployments, logs, env vars, database
      // records, uploads, members, invitations, activity logs, usage and ledger.
      name: 'database',
      required: true,
      run: async () => {
        await db.delete(organizations).where(eq(organizations.id, organizationId));
      },
    },
  ];
}

async function purgeOrganization(organizationId: string): Promise<boolean> {
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  // Resolved now: the owner's address is gone with the row.
  const notify = org ? await resolveBillingNotifyEmail(organizationId) : null;
  const done = await runSteps(organizationId, organizationSteps(organizationId));
  if (!done) return false;
  await db.delete(deletionPurgeSteps).where(eq(deletionPurgeSteps.subjectId, organizationId));
  logger.info({ organizationId }, 'organization purged');
  if (notify && org) await sendDeletionCompletedEmail(notify, { kind: 'organization', name: org.name });
  return true;
}

async function purgeUser(userId: string): Promise<boolean> {
  // Their own organizations were scheduled with the account and go first.
  const [stillOwned] = await db
    .select({ id: organizations.id })
    .from(organizationMembers)
    .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
    .where(and(eq(organizationMembers.userId, userId), eq(organizationMembers.role, 'owner')))
    .limit(1);
  if (stillOwned) return false;
  const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (!user) return true;
  // Sign-in history keeps no user id after this (set null), but it holds IPs: drop it.
  await db.delete(authEvents).where(eq(authEvents.userId, userId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(deletionPurgeSteps).where(eq(deletionPurgeSteps.subjectId, userId));
  logger.info({ userId }, 'account purged');
  await sendDeletionCompletedEmail(user.email, { kind: 'account', name: user.email });
  return true;
}

/** One week before: a last reminder, once. */
async function sendReminders(now: Date): Promise<number> {
  const horizon = new Date(now.getTime() + REMINDER_DAYS_BEFORE * DAY_MS);
  let sent = 0;
  const orgs = await db
    .select({ id: organizations.id, name: organizations.name, scheduledFor: organizations.deletionScheduledFor })
    .from(organizations)
    .where(and(isNotNull(organizations.deletionScheduledFor), lte(organizations.deletionScheduledFor, horizon)));
  for (const o of orgs) {
    if (!o.scheduledFor || o.scheduledFor <= now || (await stepStatus(o.id, 'reminder'))) continue;
    const to = await resolveBillingNotifyEmail(o.id);
    if (to) await sendDeletionReminderEmail(to, { kind: 'organization', name: o.name, scheduledFor: o.scheduledFor });
    await recordStep(o.id, 'reminder', 'done');
    sent++;
  }
  const accounts = await db
    .select({ id: users.id, email: users.email, scheduledFor: users.deletionScheduledFor })
    .from(users)
    .where(and(isNotNull(users.deletionScheduledFor), lte(users.deletionScheduledFor, horizon)));
  for (const u of accounts) {
    if (!u.scheduledFor || u.scheduledFor <= now || (await stepStatus(u.id, 'account:reminder'))) continue;
    await sendDeletionReminderEmail(u.email, { kind: 'account', name: u.email, scheduledFor: u.scheduledFor });
    await recordStep(u.id, 'account:reminder', 'done');
    sent++;
  }
  return sent;
}

export const deletionPurgeService = {
  /**
   * One sweep: reminders, then every organization and account whose date has passed. Guarded by
   * a Postgres advisory lock so two worker processes never purge the same thing at once.
   */
  async sweep(now: Date = new Date()): Promise<{ reminded: number; organizations: number; accounts: number; pending: number }> {
    const lock = await db.execute(sql`select pg_try_advisory_lock(hashtext('pushify:deletion-purge')) as ok`);
    const acquired = (lock.rows?.[0] as { ok?: boolean } | undefined)?.ok === true;
    if (!acquired) return { reminded: 0, organizations: 0, accounts: 0, pending: 0 };
    try {
      const reminded = await sendReminders(now);
      let purgedOrgs = 0;
      let purgedAccounts = 0;
      let pending = 0;
      const dueOrgs = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(isNotNull(organizations.deletionScheduledFor), lte(organizations.deletionScheduledFor, now)));
      for (const o of dueOrgs) {
        if (await purgeOrganization(o.id)) purgedOrgs++;
        else pending++;
      }
      const dueUsers = await db
        .select({ id: users.id })
        .from(users)
        .where(and(isNotNull(users.deletionScheduledFor), lte(users.deletionScheduledFor, now)));
      for (const u of dueUsers) {
        if (await purgeUser(u.id)) purgedAccounts++;
        else pending++;
      }
      return { reminded, organizations: purgedOrgs, accounts: purgedAccounts, pending };
    } finally {
      await db.execute(sql`select pg_advisory_unlock(hashtext('pushify:deletion-purge'))`);
    }
  },
};
