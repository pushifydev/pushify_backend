import { and, eq, lte } from 'drizzle-orm';
import { db } from '../db';
import { organizations, purchasedDomains } from '../db/schema';
import { getRegistrar } from '../lib/registrar';
import { retailFromWholesaleCents } from '../lib/domain-pricing';
import { resolveBillingNotifyEmail } from '../lib/billing-notify';
import {
  sendDomainRenewalReminderEmail,
  sendDomainRenewedEmail,
  sendDomainTransferResultEmail,
} from '../lib/email';
import { logger } from '../lib/logger';
import { adminNotify } from '../services/admin-notify.service';
import { infraBillingService } from '../services/infra-billing.service';
import { refundDomainCharge } from '../services/registrar-domain.service';

const SWEEP_INTERVAL_MS = 12 * 60 * 60 * 1000;
const RENEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const REMINDER_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000;

let isRunning = false;
let intervalHandle: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

async function notifyOwner(
  organizationId: string,
  send: (email: string, orgName: string) => Promise<void>
): Promise<void> {
  const [org] = await db
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  const email = await resolveBillingNotifyEmail(organizationId).catch(() => null);
  if (email && org) await send(email, org.name);
}

export async function sweepDomainRenewals(now: Date = new Date()): Promise<{
  renewed: number;
  reminded: number;
  expired: number;
}> {
  const registrar = getRegistrar();
  const stats = { renewed: 0, reminded: 0, expired: 0 };
  if (!registrar) return stats;

  const dueDomains = await db
    .select()
    .from(purchasedDomains)
    .where(
      and(
        eq(purchasedDomains.status, 'active'),
        lte(purchasedDomains.expiresAt, new Date(now.getTime() + RENEW_WINDOW_MS))
      )
    );

  for (const domain of dueDomains) {
    try {
      // Past expiry — registrar grace/redemption applies upstream; mark and stop billing
      if (domain.expiresAt.getTime() < now.getTime()) {
        await db
          .update(purchasedDomains)
          .set({ status: 'expired', updatedAt: new Date() })
          .where(eq(purchasedDomains.id, domain.id));
        stats.expired++;
        adminNotify('domain.renewal_failed', {
          organizationId: domain.organizationId,
          domain: domain.domainName,
          reason: 'expired',
        });
        continue;
      }

      const remindThrottled =
        domain.renewalReminderSentAt &&
        now.getTime() - domain.renewalReminderSentAt.getTime() < REMINDER_THROTTLE_MS;

      if (!domain.autoRenew) {
        if (!remindThrottled) {
          await notifyOwner(domain.organizationId, (email, orgName) =>
            sendDomainRenewalReminderEmail(
              email,
              orgName,
              domain.domainName,
              domain.expiresAt,
              'auto_renew_off'
            )
          );
          await db
            .update(purchasedDomains)
            .set({ renewalReminderSentAt: now, updatedAt: new Date() })
            .where(eq(purchasedDomains.id, domain.id));
          stats.reminded++;
        }
        continue;
      }

      // Prefer the registrar's live renewal price; fall back to what we captured at purchase
      const wholesaleCents =
        (await registrar.getRenewalWholesaleCents(domain.domainName).catch(() => null)) ??
        domain.renewalWholesaleCents ??
        domain.wholesalePriceCents;
      const retailCents = retailFromWholesaleCents(wholesaleCents);

      const balanceAfter = await infraBillingService.debitWallet(
        domain.organizationId,
        retailCents,
        'domain_renewal',
        `Domain renewal: ${domain.domainName} (1 year)`,
        undefined,
        { domainName: domain.domainName, wholesaleCents }
      );

      if (balanceAfter === null) {
        if (!remindThrottled) {
          await notifyOwner(domain.organizationId, (email, orgName) =>
            sendDomainRenewalReminderEmail(
              email,
              orgName,
              domain.domainName,
              domain.expiresAt,
              'insufficient_credits'
            )
          );
          await db
            .update(purchasedDomains)
            .set({
              renewalReminderSentAt: now,
              lastRenewalError: 'insufficient_credits',
              updatedAt: new Date(),
            })
            .where(eq(purchasedDomains.id, domain.id));
          stats.reminded++;
        }
        continue;
      }

      let renewed;
      try {
        renewed = await registrar.renew(domain.domainName, { years: 1, wholesaleCents });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'unknown';
        logger.error({ err: error, domain: domain.domainName }, 'Domain renewal failed');
        await refundDomainCharge(
          domain.organizationId,
          retailCents,
          `Refund: domain renewal failed — ${domain.domainName}`
        ).catch((refundErr) =>
          logger.error({ err: refundErr, domain: domain.domainName }, 'Domain renewal refund failed')
        );
        await db
          .update(purchasedDomains)
          .set({ lastRenewalError: message.slice(0, 500), updatedAt: new Date() })
          .where(eq(purchasedDomains.id, domain.id));
        if (!remindThrottled) {
          await notifyOwner(domain.organizationId, (email, orgName) =>
            sendDomainRenewalReminderEmail(
              email,
              orgName,
              domain.domainName,
              domain.expiresAt,
              'renewal_failed'
            )
          );
          await db
            .update(purchasedDomains)
            .set({ renewalReminderSentAt: now })
            .where(eq(purchasedDomains.id, domain.id));
        }
        adminNotify('domain.renewal_failed', {
          organizationId: domain.organizationId,
          domain: domain.domainName,
          reason: message.slice(0, 200),
        });
        continue;
      }

      const newExpiry =
        renewed.expiresAt ?? new Date(domain.expiresAt.getTime() + 365 * 24 * 60 * 60 * 1000);
      await db
        .update(purchasedDomains)
        .set({
          expiresAt: newExpiry,
          lastRenewalError: null,
          renewalReminderSentAt: null,
          updatedAt: new Date(),
        })
        .where(eq(purchasedDomains.id, domain.id));
      stats.renewed++;

      await notifyOwner(domain.organizationId, (email, orgName) =>
        sendDomainRenewedEmail(email, orgName, domain.domainName, retailCents, newExpiry)
      );
      adminNotify('domain.renewed', {
        organizationId: domain.organizationId,
        domain: domain.domainName,
        retail: `$${(retailCents / 100).toFixed(2)}`,
        newExpiry: newExpiry.toISOString().slice(0, 10),
      });
    } catch (error) {
      logger.error({ err: error, domain: domain.domainName }, 'Domain renewal sweep item failed');
    }
  }

  return stats;
}

/** Poll in-flight transfers; activate completed ones, refund cancelled/rejected ones. */
export async function sweepPendingTransfers(): Promise<{ completed: number; failed: number }> {
  const registrar = getRegistrar();
  const stats = { completed: 0, failed: 0 };
  if (!registrar) return stats;

  const pending = await db
    .select()
    .from(purchasedDomains)
    .where(eq(purchasedDomains.status, 'transfer_pending'));

  for (const domain of pending) {
    try {
      const status = await registrar.getTransferStatus(domain.domainName).catch(() => 'unknown' as const);
      if (status === 'pending' || status === 'unknown') continue;

      if (status === 'completed') {
        const info = await registrar.getDomainInfo(domain.domainName).catch(() => null);
        await db
          .update(purchasedDomains)
          .set({
            status: 'active',
            expiresAt: info?.expiresAt ?? domain.expiresAt,
            renewalWholesaleCents: info?.renewalWholesaleCents ?? domain.renewalWholesaleCents,
            lastRenewalError: null,
            updatedAt: new Date(),
          })
          .where(eq(purchasedDomains.id, domain.id));
        stats.completed++;
        await notifyOwner(domain.organizationId, (email, orgName) =>
          sendDomainTransferResultEmail(email, orgName, domain.domainName, true)
        );
        adminNotify('domain.transfer_completed', {
          organizationId: domain.organizationId,
          domain: domain.domainName,
        });
        continue;
      }

      // cancelled / failed — money back, mark the row
      await refundDomainCharge(
        domain.organizationId,
        domain.purchasePriceCents,
        `Refund: domain transfer ${status} — ${domain.domainName}`
      ).catch((err) =>
        logger.error({ err, domain: domain.domainName }, 'Transfer refund failed')
      );
      await db
        .update(purchasedDomains)
        .set({ status: 'transfer_failed', lastRenewalError: `transfer_${status}`, updatedAt: new Date() })
        .where(eq(purchasedDomains.id, domain.id));
      stats.failed++;
      await notifyOwner(domain.organizationId, (email, orgName) =>
        sendDomainTransferResultEmail(email, orgName, domain.domainName, false)
      );
      adminNotify('domain.transfer_failed', {
        organizationId: domain.organizationId,
        domain: domain.domainName,
        reason: status,
      });
    } catch (error) {
      logger.error({ err: error, domain: domain.domainName }, 'Transfer sweep item failed');
    }
  }

  return stats;
}

export function startDomainRenewalWorker(): void {
  if (isRunning) {
    logger.warn('Domain renewal worker is already running');
    return;
  }
  if (!getRegistrar()) {
    logger.info('Domain renewal worker not started (no registrar configured)');
    return;
  }

  isRunning = true;
  logger.info('Domain renewal worker started (12h sweep, 30-day renewal window)');

  const tick = () => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    sweepDomainRenewals()
      .then((stats) => {
        if (stats.renewed || stats.reminded || stats.expired) {
          logger.info(stats, 'Domain renewal sweep completed');
        }
        return sweepPendingTransfers();
      })
      .then((stats) => {
        if (stats.completed || stats.failed) {
          logger.info(stats, 'Domain transfer sweep completed');
        }
      })
      .catch((err) => logger.error({ err }, 'Domain renewal sweep failed'))
      .finally(() => {
        sweepInProgress = false;
      });
  };

  tick();
  intervalHandle = setInterval(tick, SWEEP_INTERVAL_MS);
}

export function stopDomainRenewalWorker(): void {
  isRunning = false;
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  logger.info('Domain renewal worker stopped');
}
