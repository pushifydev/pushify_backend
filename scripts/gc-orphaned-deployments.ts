/**
 * One-off / cron GC: remove orphaned project deployments left on the LOCAL (shared Pushify)
 * host — containers + built images + nginx vhost + project dir — for projects that have been
 * moved to the user's own server (`project.serverId` set) or deleted, but whose artifacts
 * still linger on the shared host and waste disk.
 *
 * Safe: only ever touches projects that must NOT have a local deployment. The background
 * service runs this every 30 min automatically; run it here to reclaim space immediately.
 *
 *   npm run gc:orphans
 *
 * Run on the API host (uses the same DATABASE_URL / .env and the local Docker daemon).
 */
import { gcOrphanedLocalDeployments } from '../src/services/server-reconcile.service';
import { closeDatabasePool } from '../src/db';
import { logger } from '../src/lib/logger';

async function main() {
  const res = await gcOrphanedLocalDeployments();
  logger.info(res, 'Orphaned-deployment GC complete');
}

main()
  .then(async () => {
    await closeDatabasePool();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Orphaned-deployment GC failed',
    );
    await closeDatabasePool();
    process.exit(1);
  });
