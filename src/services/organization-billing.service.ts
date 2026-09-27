import { HTTPException } from 'hono/http-exception';
import { env } from '../config/env';
import { eq, and, ne, inArray } from 'drizzle-orm';
import { db } from '../db';
import { organizations, projects, servers } from '../db/schema';
import type { BillingStatus } from '../db/schema/organizations';
import { organizationRepository } from '../repositories/organization.repository';
import { projectRepository } from '../repositories/project.repository';
import { createProvider, type ProviderType } from '../providers';
import { t, type SupportedLocale } from '../i18n';
import { logger } from '../lib/logger';
import { sendBillingPaymentFailedEmail, sendBillingSuspendedEmail } from '../lib/email';
import { resolveBillingNotifyEmail } from '../lib/billing-notify';
import { pauseProjectContainers } from '../lib/project-remote-cleanup';
import { getStripe, getPlanFromPriceId } from '../lib/stripe';
import { invoiceSubscriptionId } from '../lib/stripe-invoices';

const PAYMENT_FAILED_EMAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function getProviderToken(provider: ProviderType): string {
  switch (provider) {
    case 'hetzner':
      return env.HETZNER_API_TOKEN || '';
    default:
      return '';
  }
}

export async function getOrganizationBillingStatus(organizationId: string): Promise<BillingStatus> {
  const org = await organizationRepository.findById(organizationId);
  const status = (org?.billingStatus ?? 'active') as BillingStatus;
  if (status === 'past_due' && org) {
    return (await reconcilePastDue(org)) ? 'active' : status;
  }
  return status;
}

/** Don't ask Stripe again on every click for an organisation that really owes money. */
const RECONCILE_NEGATIVE_TTL_MS = 60 * 1000;
const owingCheckedAt = new Map<string, number>();

type ReconcilableOrg = {
  id: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
};

/**
 * past_due is a copy of Stripe's state, and a copy can go stale: a webhook for an older
 * subscription, one that arrived out of order or never arrived, or a new subscription that was
 * never linked. Stripe is the source of truth, so ask it — about the whole customer, not only the
 * linked subscription:
 *  - a subscription in good standing (the linked one first, else the newest) → active, and link it;
 *  - nothing live and nothing owed → the flag has nothing behind it → active;
 *  - a subscription past due / unpaid, or an open invoice → really owes; stay blocked.
 * Returns true when the flag was cleared.
 */
export async function reconcilePastDue(org: ReconcilableOrg, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!env.STRIPE_SECRET_KEY || !org.stripeCustomerId) return false;
  const last = owingCheckedAt.get(org.id);
  if (!opts.force && last && Date.now() - last < RECONCILE_NEGATIVE_TTL_MS) return false;

  try {
    const stripe = getStripe();
    const subs = (await stripe.subscriptions.list({ customer: org.stripeCustomerId, status: 'all', limit: 20 })).data;
    const good = subs.filter((s) => s.status === 'active' || s.status === 'trialing');
    const pick = good.find((s) => s.id === org.stripeSubscriptionId) ?? [...good].sort((a, b) => b.created - a.created)[0];

    if (pick) {
      const priceId = pick.items.data[0]?.price?.id;
      const plan = priceId ? getPlanFromPriceId(priceId) : null;
      await db
        .update(organizations)
        .set({
          billingStatus: 'active',
          billingPaymentFailedNotifiedAt: null,
          stripeSubscriptionId: pick.id,
          ...(plan ? { plan } : {}),
          updatedAt: new Date(),
        })
        .where(eq(organizations.id, org.id));
      owingCheckedAt.delete(org.id);
      logger.info(
        { organizationId: org.id, subscriptionId: pick.id, relinked: pick.id !== org.stripeSubscriptionId },
        'past_due cleared: Stripe has a subscription in good standing',
      );
      return true;
    }

    // An open invoice of a subscription that has ended (Stripe gave up and cancelled it) is not
    // debt we enforce: paying it would buy nothing. Only one-off invoices and live subscriptions' count.
    const liveSubIds = new Set(subs.filter((s) => s.status === 'past_due' || s.status === 'unpaid').map((s) => s.id));
    const openInvoices = (await stripe.invoices.list({ customer: org.stripeCustomerId, status: 'open', limit: 20 })).data;
    const owing =
      liveSubIds.size > 0 ||
      openInvoices.some((inv) => {
        const sub = invoiceSubscriptionId(inv);
        return !sub || liveSubIds.has(sub);
      });
    if (owing) {
      owingCheckedAt.set(org.id, Date.now());
      return false;
    }

    await organizationBillingService.markActive(org.id);
    owingCheckedAt.delete(org.id);
    logger.info({ organizationId: org.id }, 'past_due cleared: nothing live and nothing owed in Stripe');
    return true;
  } catch (err) {
    logger.warn({ err, organizationId: org.id }, 'past_due reconcile with Stripe failed');
    return false;
  }
}

/** Background pass: every past_due organisation is re-checked, so a paid customer is unblocked without clicking. */
export async function reconcilePastDueOrganizations(): Promise<{ checked: number; cleared: number }> {
  const rows = await db
    .select({
      id: organizations.id,
      stripeCustomerId: organizations.stripeCustomerId,
      stripeSubscriptionId: organizations.stripeSubscriptionId,
    })
    .from(organizations)
    .where(eq(organizations.billingStatus, 'past_due'));
  let cleared = 0;
  for (const org of rows) {
    if (await reconcilePastDue(org, { force: true })) cleared++;
  }
  return { checked: rows.length, cleared };
}

export function assertOrganizationBillingAllowsMutations(
  billingStatus: BillingStatus,
  locale: SupportedLocale
): void {
  if (billingStatus === 'suspended') {
    throw new HTTPException(403, { message: t(locale, 'organizationBilling', 'suspended') });
  }
  if (billingStatus === 'past_due') {
    throw new HTTPException(402, { message: t(locale, 'organizationBilling', 'pastDue') });
  }
}

export async function assertOrganizationCanMutateResources(
  organizationId: string,
  locale: SupportedLocale
): Promise<void> {
  const status = await getOrganizationBillingStatus(organizationId);
  assertOrganizationBillingAllowsMutations(status, locale);
}

export async function canOrganizationDeploy(organizationId: string): Promise<boolean> {
  const status = await getOrganizationBillingStatus(organizationId);
  return status === 'active';
}

async function stopManagedServerForBillingSuspension(
  serverId: string,
  organizationId: string
): Promise<boolean> {
  const [server] = await db
    .select()
    .from(servers)
    .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
    .limit(1);

  if (!server?.isManaged || !server.providerId || server.provider === 'self_hosted') {
    return false;
  }

  const apiToken = getProviderToken(server.provider as ProviderType);
  if (!apiToken) return false;

  try {
    const provider = createProvider(server.provider as ProviderType, apiToken);
    await provider.powerOff(server.providerId);

    await db
      .update(servers)
      .set({
        status: 'stopped',
        statusMessage: 'billing_suspended',
        updatedAt: new Date(),
      })
      .where(eq(servers.id, serverId));

    return true;
  } catch (err) {
    logger.warn({ err, serverId, organizationId }, 'Failed to stop managed server for billing suspension');
    return false;
  }
}

export const organizationBillingService = {
  async markPastDue(organizationId: string): Promise<void> {
    // A late payment_failed (Stripe's last retry arrives around the cancellation) must not turn a
    // suspended organisation — subscription ended, servers stopped — back into a merely late one.
    await db
      .update(organizations)
      .set({ billingStatus: 'past_due', updatedAt: new Date() })
      .where(and(eq(organizations.id, organizationId), ne(organizations.billingStatus, 'suspended')));
  },

  async markActive(organizationId: string): Promise<void> {
    await db
      .update(organizations)
      .set({
        billingStatus: 'active',
        billingPaymentFailedNotifiedAt: null,
        updatedAt: new Date(),
      })
      .where(eq(organizations.id, organizationId));
  },

  async markSuspended(organizationId: string): Promise<void> {
    await db
      .update(organizations)
      .set({ billingStatus: 'suspended', updatedAt: new Date() })
      .where(eq(organizations.id, organizationId));
  },

  async notifyPaymentFailedIfDue(
    organizationId: string,
    orgName: string,
    payUrl?: string | null,
    reason: 'failed' | 'action_required' = 'failed',
  ): Promise<boolean> {
    const [org] = await db
      .select({ billingPaymentFailedNotifiedAt: organizations.billingPaymentFailedNotifiedAt })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    const last = org?.billingPaymentFailedNotifiedAt;
    const now = Date.now();
    if (last && now - last.getTime() < PAYMENT_FAILED_EMAIL_COOLDOWN_MS) {
      return false;
    }

    const notifyEmail = await resolveBillingNotifyEmail(organizationId);
    if (!notifyEmail) return false;

    await sendBillingPaymentFailedEmail(notifyEmail, orgName, 'en', payUrl, reason);
    await db
      .update(organizations)
      .set({ billingPaymentFailedNotifiedAt: new Date(), updatedAt: new Date() })
      .where(eq(organizations.id, organizationId));
    return true;
  },

  /**
   * After subscription cancellation: stop managed servers, pause projects, block new usage.
   */
  async suspendOrganization(organizationId: string): Promise<{
    serversStopped: number;
    projectsPaused: number;
    containersPaused: number;
  }> {
    await this.markSuspended(organizationId);

    let serversStopped = 0;
    let projectsPaused = 0;
    let containersPaused = 0;

    const managedServers = await db
      .select()
      .from(servers)
      .where(
        and(
          eq(servers.organizationId, organizationId),
          eq(servers.isManaged, true),
          ne(servers.provider, 'self_hosted'),
          inArray(servers.status, ['running', 'rebooting'])
        )
      );

    for (const server of managedServers) {
      const stopped = await stopManagedServerForBillingSuspension(server.id, organizationId);
      if (stopped) serversStopped++;
    }

    const activeProjects = await db
      .select()
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.status, 'active')));

    for (const project of activeProjects) {
      try {
        const stopped = await pauseProjectContainers(project);
        if (stopped) containersPaused++;
      } catch (err) {
        logger.warn(
          { err, projectId: project.id, organizationId },
          'Failed to pause containers during billing suspension',
        );
      }
      await projectRepository.updateStatus(project.id, 'paused');
      projectsPaused++;
    }

    const org = await organizationRepository.findById(organizationId);
    const notifyEmail = await resolveBillingNotifyEmail(organizationId);
    if (notifyEmail && org) {
      await sendBillingSuspendedEmail(notifyEmail, org.name, 'en');
    }

    logger.info(
      { organizationId, serversStopped, projectsPaused, containersPaused },
      'Organization suspended for billing',
    );
    return { serversStopped, projectsPaused, containersPaused };
  },
};
