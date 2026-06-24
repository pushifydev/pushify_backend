/**
 * One-off backfill: grant the plan's included compute credit to existing paying
 * organizations that subscribed *before* the included-credit feature shipped
 * (v0.2.0-beta.17) and therefore never received it on checkout.
 *
 * Safe to run repeatedly. grantIncludedInfraCredit() tops the infra wallet UP to the
 * plan allowance and never over-credits, so organizations that already hold >= their
 * allowance (incl. anyone already granted) are skipped automatically.
 *
 *   npm run backfill:infra-credit               # apply
 *   npm run backfill:infra-credit -- --dry-run  # preview only, no writes
 *
 * Run on the API host (uses the same DATABASE_URL / .env as the server).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { organizations } from '../src/db/schema';
import { infraBillingService } from '../src/services/infra-billing.service';
import { getIncludedInfraCreditCents, type PlanType } from '../src/lib/plans';
import { logger } from '../src/lib/logger';

const dryRun = process.argv.includes('--dry-run');
const PAID_PLANS: PlanType[] = ['hobby', 'pro', 'business'];

async function main() {
  const orgs = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      plan: organizations.plan,
      balance: organizations.infraWalletBalanceCents,
    })
    .from(organizations)
    .where(and(inArray(organizations.plan, PAID_PLANS), eq(organizations.billingStatus, 'active')));

  logger.info({ count: orgs.length, dryRun }, 'Backfill: active paying organizations found');

  let credited = 0;
  let totalCents = 0;

  for (const org of orgs) {
    const plan = org.plan as PlanType;
    const allowance = getIncludedInfraCreditCents(plan);
    const current = org.balance ?? 0;
    const wouldGrant = Math.max(0, allowance - current);

    if (wouldGrant <= 0) {
      logger.info(
        { orgId: org.id, name: org.name, plan, balanceCents: current, allowanceCents: allowance },
        'skip — already at/above allowance',
      );
      continue;
    }

    if (dryRun) {
      logger.info({ orgId: org.id, name: org.name, plan, wouldGrantCents: wouldGrant }, 'DRY-RUN would grant');
      credited++;
      totalCents += wouldGrant;
      continue;
    }

    const res = await infraBillingService.grantIncludedInfraCredit(org.id, plan);
    if (res.grantedCents > 0) {
      credited++;
      totalCents += res.grantedCents;
      logger.info(
        { orgId: org.id, name: org.name, plan, grantedCents: res.grantedCents, balanceAfterCents: res.balanceAfterCents },
        'granted included infra credit',
      );
    }
  }

  logger.info(
    {
      totalOrgs: orgs.length,
      credited,
      totalGrantedCents: totalCents,
      totalGrantedUsd: (totalCents / 100).toFixed(2),
      dryRun,
    },
    'Backfill complete',
  );
}

main()
  .then(async () => {
    await closeDatabasePool();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Backfill failed');
    await closeDatabasePool();
    process.exit(1);
  });
