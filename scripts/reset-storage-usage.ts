/**
 * One-off reset: zero out the inflated `storageBytesPeak` for the CURRENT billing period
 * (startOfUtcMonth) in `organizationMonthlyUsage`.
 *
 * Historically storage was metered cumulatively per deploy (and over-counted on shared
 * hosts), so the peak grew unbounded and unfairly blocked users with "Monthly storage limit
 * reached." This clears those values immediately; the next docker-disk sync re-records the
 * correct per-org image footprint.
 *
 *   npm run reset:storage-usage                 # reset all orgs (current period)
 *   npm run reset:storage-usage -- --org <id>   # reset a single organization
 *
 * Run on the API host (uses the same DATABASE_URL / .env as the server).
 */
import { and, eq } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { organizationMonthlyUsage } from '../src/db/schema/usage';
import { logger } from '../src/lib/logger';

function startOfUtcMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function parseOrgArg(): string | null {
  const idx = process.argv.indexOf('--org');
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return null;
}

async function main() {
  const periodStart = startOfUtcMonth();
  const orgId = parseOrgArg();

  const where = orgId
    ? and(
        eq(organizationMonthlyUsage.periodStart, periodStart),
        eq(organizationMonthlyUsage.organizationId, orgId),
      )
    : eq(organizationMonthlyUsage.periodStart, periodStart);

  const updated = await db
    .update(organizationMonthlyUsage)
    .set({ storageBytesPeak: 0, updatedAt: new Date() })
    .where(where)
    .returning({ id: organizationMonthlyUsage.id });

  logger.info(
    { rowsReset: updated.length, periodStart: periodStart.toISOString(), orgId: orgId ?? 'ALL' },
    'Storage usage reset complete',
  );
}

main()
  .then(async () => {
    await closeDatabasePool();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Storage usage reset failed',
    );
    await closeDatabasePool();
    process.exit(1);
  });
