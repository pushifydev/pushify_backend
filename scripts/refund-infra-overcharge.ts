/**
 * Refund the hourly-billing rounding overcharge (fixed in 0.2.0-beta.48).
 *
 * The old code charged an integer hourly price derived with round-then-ceil, inflating
 * small servers' rate up to ~2.5×. Each `server_hourly_charge` transaction was intended
 * to bill ONE hour, so the fair total is monthly/730 × (number of charges). This script
 * computes, per organization, the difference between what was actually debited and that
 * fair amount, and credits it back as an adjustment.
 *
 *   npm run refund:infra-overcharge            # dry run — prints the table
 *   npm run refund:infra-overcharge -- --apply # actually credits the wallets
 */
import { eq, and } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { servers } from '../src/db/schema/servers';
import { infraWalletTransactions } from '../src/db/schema';
import { infraBillingService } from '../src/services/infra-billing.service';
import { HOURS_PER_MONTH } from '../src/lib/infra-billing';
import { logger } from '../src/lib/logger';

const apply = process.argv.includes('--apply');

async function main() {
  const managed = await db.select().from(servers).where(eq(servers.isManaged, true));

  const perOrg = new Map<string, { refund: number; details: string[] }>();

  for (const server of managed) {
    const monthly = server.customerPriceMonthlyCents;
    if (!monthly || monthly <= 0) continue;

    const txns = await db
      .select({ amountCents: infraWalletTransactions.amountCents })
      .from(infraWalletTransactions)
      .where(
        and(
          eq(infraWalletTransactions.serverId, server.id),
          eq(infraWalletTransactions.type, 'server_hourly_charge'),
        ),
      );

    if (txns.length === 0) continue;

    const paid = txns.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
    // Each old-style charge was meant to be one hour at the (accurate) monthly rate.
    const fair = Math.round((monthly * txns.length) / HOURS_PER_MONTH);
    const refund = paid - fair;

    if (refund > 0) {
      const entry = perOrg.get(server.organizationId) ?? { refund: 0, details: [] };
      entry.refund += refund;
      entry.details.push(
        `${server.name}: ${txns.length} charges, paid ${paid}¢, fair ${fair}¢ → refund ${refund}¢`,
      );
      perOrg.set(server.organizationId, entry);
    }
  }

  if (perOrg.size === 0) {
    logger.info('No overcharges found — nothing to refund');
    return;
  }

  for (const [orgId, { refund, details }] of perOrg) {
    logger.info({ orgId, refundCents: refund, details }, apply ? 'Refunding' : 'DRY RUN — would refund');
    if (apply) {
      await infraBillingService.creditWallet(
        orgId,
        refund,
        'Adjustment: refund for hourly billing rounding overcharge',
      );
    }
  }

  if (!apply) {
    logger.info('Dry run complete. Re-run with --apply to credit the wallets.');
  }
}

main()
  .then(async () => {
    await closeDatabasePool();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'refund script failed');
    await closeDatabasePool();
    process.exit(1);
  });
