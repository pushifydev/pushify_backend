import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { db } from '../db';
import { organizations, servers } from '../db/schema';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { resolveBillingNotifyEmail } from '../lib/billing-notify';
import { sendStoppedServerDeletedEmail, sendStoppedServerWarningEmail } from '../lib/email';
import { createProvider, type ProviderType } from '../providers';
import { destroyAtProvider } from './server.service';

/**
 * A managed server Pushify powered off because it was not paid for (subscription ended, or the
 * wallet ran dry) still costs Pushify at Hetzner. Left off for 30 days, it is deleted: warnings
 * on day 14 and day 27, then the server with its snapshots and SSH key on day 30. Paying again
 * (top-up, renewed plan) or starting the server stops the clock.
 */

export const NON_PAYMENT_REASONS = ['billing_suspended', 'infra_credits_stopped'] as const;
export const STOP_SCHEDULE = { firstWarningDay: 14, finalWarningDay: 27, deleteDay: 30 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type StoppedServerAction = 'first-warning' | 'final-warning' | 'delete' | null;

/** What is due for a server stopped at `stoppedAt` that has had `warningStep` warnings. */
export function stoppedServerAction(stoppedAt: Date, warningStep: number, now: Date): StoppedServerAction {
  const days = (now.getTime() - stoppedAt.getTime()) / DAY_MS;
  if (days >= STOP_SCHEDULE.deleteDay) return 'delete';
  if (days >= STOP_SCHEDULE.finalWarningDay && warningStep < 2) return 'final-warning';
  if (days >= STOP_SCHEDULE.firstWarningDay && warningStep < 1) return 'first-warning';
  return null;
}

export function deletionDateFor(stoppedAt: Date): Date {
  return new Date(stoppedAt.getTime() + STOP_SCHEDULE.deleteDay * DAY_MS);
}

function providerToken(provider: ProviderType): string {
  return provider === 'hetzner' ? env.HETZNER_API_TOKEN || '' : '';
}

export const stoppedServerService = {
  async sweep(now: Date = new Date()): Promise<{ warned: number; deleted: number; cleared: number }> {
    // Running again (or deleted from the dashboard): the clock no longer applies.
    const cleared = await db
      .update(servers)
      .set({ stoppedAt: null, stopWarningStep: 0 })
      .where(and(isNotNull(servers.stoppedAt), ne(servers.status, 'stopped')))
      .returning({ id: servers.id });

    const rows = await db
      .select({ server: servers, org: organizations })
      .from(servers)
      .innerJoin(organizations, eq(organizations.id, servers.organizationId))
      .where(
        and(
          eq(servers.isManaged, true),
          eq(servers.status, 'stopped'),
          inArray(servers.statusMessage, [...NON_PAYMENT_REASONS]),
        ),
      );

    let warned = 0;
    let deleted = 0;
    for (const { server, org } of rows) {
      // A renewed plan does not clear billing_suspended on the server; once the organization is
      // active again, a server left off is the customer's choice, not non-payment.
      const stillUnpaid =
        org.deletionScheduledFor === null &&
        (server.statusMessage === 'infra_credits_stopped' || org.billingStatus === 'suspended');
      if (!stillUnpaid) {
        if (server.stoppedAt) {
          await db.update(servers).set({ stoppedAt: null, stopWarningStep: 0 }).where(eq(servers.id, server.id));
        }
        continue;
      }
      if (!server.stoppedAt) {
        // Stopped before this was tracked: the 30 days start now.
        await db.update(servers).set({ stoppedAt: now, stopWarningStep: 0 }).where(eq(servers.id, server.id));
        continue;
      }

      const action = stoppedServerAction(server.stoppedAt, server.stopWarningStep, now);
      if (!action) continue;
      const to = await resolveBillingNotifyEmail(org.id);

      if (action === 'first-warning' || action === 'final-warning') {
        if (to) {
          await sendStoppedServerWarningEmail(to, {
            orgName: org.name,
            serverName: server.name,
            deleteOn: deletionDateFor(server.stoppedAt),
            final: action === 'final-warning',
          });
        }
        await db
          .update(servers)
          .set({ stopWarningStep: action === 'final-warning' ? 2 : 1 })
          .where(eq(servers.id, server.id));
        warned++;
        continue;
      }

      try {
        const token = providerToken(server.provider as ProviderType);
        if (token && server.providerId) {
          await destroyAtProvider(createProvider(server.provider as ProviderType, token), server);
        }
        await db.delete(servers).where(eq(servers.id, server.id));
        deleted++;
        logger.info({ serverId: server.id, organizationId: org.id }, 'Deleted a managed server left off for non-payment');
        if (to) await sendStoppedServerDeletedEmail(to, { orgName: org.name, serverName: server.name });
        const { adminNotify } = await import('./admin-notify.service');
        adminNotify('server.deleted', { server: server.name, organizationId: org.id, reason: 'non-payment, 30 days off' });
      } catch (err) {
        logger.error({ err, serverId: server.id }, 'Could not delete a server left off for non-payment');
      }
    }
    return { warned, deleted, cleared: cleared.length };
  },
};
