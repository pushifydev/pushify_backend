import { HTTPException } from 'hono/http-exception';
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

const PAYMENT_FAILED_EMAIL_COOLDOWN_MS = 24 * 60 * 60 * 1000;

function getProviderToken(provider: ProviderType): string {
  switch (provider) {
    case 'hetzner':
      return process.env.HETZNER_API_TOKEN || '';
    default:
      return '';
  }
}

export async function getOrganizationBillingStatus(organizationId: string): Promise<BillingStatus> {
  const org = await organizationRepository.findById(organizationId);
  return (org?.billingStatus ?? 'active') as BillingStatus;
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

  async notifyPaymentFailedIfDue(organizationId: string, orgName: string): Promise<boolean> {
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

    await sendBillingPaymentFailedEmail(notifyEmail, orgName);
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
  }> {
    await this.markSuspended(organizationId);

    let serversStopped = 0;
    let projectsPaused = 0;

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
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.organizationId, organizationId), eq(projects.status, 'active')));

    for (const p of activeProjects) {
      await projectRepository.updateStatus(p.id, 'paused');
      projectsPaused++;
    }

    const org = await organizationRepository.findById(organizationId);
    const notifyEmail = await resolveBillingNotifyEmail(organizationId);
    if (notifyEmail && org) {
      await sendBillingSuspendedEmail(notifyEmail, org.name, 'en');
    }

    logger.info({ organizationId, serversStopped, projectsPaused }, 'Organization suspended for billing');
    return { serversStopped, projectsPaused };
  },
};
