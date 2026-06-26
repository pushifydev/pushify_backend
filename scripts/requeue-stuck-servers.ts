/**
 * One-off recovery: rescue managed servers stuck at `provisioning` (or `running` but
 * with setup never finished) after the one-shot `server-status` poll job exhausted.
 *
 * It runs the same reconciliation the periodic sweeper uses
 * (reconcileProvisioningServers), which promotes servers the provider now reports as
 * `running`, hands them off to the `server-setup` job, and times out long-stuck ones
 * to `error`. For `running`-but-unfinished-setup servers it additionally re-enqueues a
 * `server-status` job so the normal fast path picks the setup hand-off back up. Safe to
 * run repeatedly — setup jobs use a fixed jobId so BullMQ de-dupes.
 *
 *   npm run requeue:stuck-servers
 *
 * Run on the API host (uses the same DATABASE_URL / .env as the server).
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { servers } from '../src/db/schema/servers';
import { getServerStatusQueue } from '../src/queue/queues';
import { reconcileProvisioningServers } from '../src/services/server-reconcile.service';
import { logger } from '../src/lib/logger';

async function main() {
  // 1) Reconcile everything stuck at `provisioning` (promote / hand off / time out).
  const result = await reconcileProvisioningServers();
  logger.info(result, 'requeue:stuck-servers — provisioning reconcile complete');

  // 2) Re-kick servers that reached `running` but never finished setup, by re-enqueuing
  //    a `server-status` job (the normal fast path that re-triggers the setup hand-off).
  const unfinished = await db
    .select()
    .from(servers)
    .where(
      and(
        eq(servers.status, 'running'),
        eq(servers.isManaged, true),
        inArray(servers.setupStatus, ['pending', 'installing']),
      ),
    );

  let requeued = 0;
  const statusQueue = getServerStatusQueue();
  for (const server of unfinished) {
    if (!server.providerId) continue;
    await statusQueue.add(
      `server-status-${server.id}`,
      {
        serverId: server.id,
        providerId: server.providerId,
        provider: server.provider,
      },
      { jobId: `server-status-${server.id}` },
    );
    requeued++;
    logger.info({ serverId: server.id }, 'requeue:stuck-servers — re-enqueued server-status job');
  }

  logger.info(
    {
      inspected: result.inspected,
      recovered: result.recovered,
      failed: result.failed,
      runningSetupRequeued: requeued,
    },
    'requeue:stuck-servers — done',
  );
}

main()
  .then(async () => {
    await closeDatabasePool();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'requeue:stuck-servers failed');
    await closeDatabasePool();
    process.exit(1);
  });
