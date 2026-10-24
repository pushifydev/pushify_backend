/**
 * One-off: re-run the deploy failure classifier on each project's latest failed deploy and store
 * its category and first error line (deployments.failure_category / failure_summary), for
 * failures recorded before the worker wrote them. Run after migration 0079. Safe to run again: a
 * row it filled is skipped, and the result depends only on the stored log and error message.
 *
 *   npm run backfill:failure-category              # write
 *   npm run backfill:failure-category -- --dry-run # only count what would change
 *
 * Run on the API host (uses the same DATABASE_URL / .env as the server).
 */
import { deployFailureBackfillService } from '../src/services/deploy-failure-backfill.service';
import { closeDatabasePool } from '../src/db';
import { logger } from '../src/lib/logger';

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const result = await deployFailureBackfillService.backfillLatestFailures({ dryRun });
  logger.info({ ...result, dryRun }, 'backfill:failure-category — done');
}

main()
  .then(async () => {
    await closeDatabasePool();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'backfill:failure-category failed');
    await closeDatabasePool();
    process.exit(1);
  });
