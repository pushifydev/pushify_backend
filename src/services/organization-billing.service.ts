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
import { getStripe } from '../lib/stripe';

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
  if (status === 'past_due' && org?.stripeSubscriptionId) {
    return (await reconcilePastDue(organizationId, org.stripeSubscriptionId)) ? 'active' : status;
  }
  return status;
}

/**
 * past_due is a copy of Stripe's state, and a copy can go stale: a webhook for an older
 * subscription, or one that arrived out of order, can leave an organisation blocked after it has
 * paid. Before refusing, ask Stripe: if the current subscription is in good standing, clear the flag.
 */
async function reconcilePastDue(organizationId: string, subscriptionId: string): Promise<boolean> {
  if (!env.STRIPE_SECRET_KEY) return false;
  try {
    const sub = await getStripe().subscriptions.retrieve(subscriptionId);
    if (sub.status !== 'active' && sub.status !== 'trialing') return false;
    await organizationBillingService.markActive(organizationId);
    logger.info({ organizationId, subscriptionId }, 'past_due cleared: Stripe reports the subscription in good standing');
    return true;
  } catch (err) {
    logger.warn({ err, organizationId, subscriptionId }, 'past_due reconcile with Stripe failed');
    return false;
  }
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
    await db
      .update(organizations)
      .set({ billingStatus: 'past_due', updatedAt: new Date() })
      .where(eq(organizations.id, organizationId));
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
