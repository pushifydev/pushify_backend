import { env } from '../config/env';
import { logger } from '../lib/logger';
import { reconcilePastDueOrganizations } from '../services/organization-billing.service';

/**
 * Re-checks past_due organisations against Stripe every few minutes, so a customer who has paid
 * (on Stripe's invoice page, by a Smart Retry, after a card update) is unblocked even if a webhook
 * was missed or out of order — without having to click anything first.
 */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;
let sweepInProgress = false;

export function startBillingReconcileWorker(): void {
  if (intervalHandle) return;
  if (!env.STRIPE_SECRET_KEY) {
    logger.info('Billing reconcile worker not started (no STRIPE_SECRET_KEY)');
    return;
  }

  const tick = () => {
    if (sweepInProgress) return;
    sweepInProgress = true;
    reconcilePastDueOrganizations()
      .then((stats) => {
        if (stats.cleared) logger.info(stats, 'Billing reconcile: past_due organisations cleared');
      })
      .catch((err) => logger.error({ err }, 'Billing reconcile sweep failed'))
      .finally(() => {
        sweepInProgress = false;
      });
  };

  intervalHandle = setInterval(tick, SWEEP_INTERVAL_MS);
  setTimeout(tick, 30 * 1000);
  logger.info('Billing reconcile worker started (10 min sweep)');
}

export function stopBillingReconcileWorker(): void {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}
