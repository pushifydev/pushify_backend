/**
 * Server provisioning reconciliation (safety-net sweeper).
 *
 * The fast path for bringing a managed server online is the one-shot BullMQ
 * `server-status` poll job (see queue/workers/server-status.worker.ts): it polls
 * the provider for ~5 minutes and, once the VM reports `running`, hands off to the
 * `server-setup` job. If the VM boots slower than that retry budget the poll job
 * simply exhausts and gives up — leaving the server stuck at `provisioning` forever
 * with no recovery, even though the provider eventually reports `running`.
 *
 * `reconcileProvisioningServers()` is an INDEPENDENT periodic reconciler (wired up
 * in runtime/background-workers.ts) that re-checks every server still stuck at
 * `provisioning` and drives it forward: if the provider now says `running` it
 * promotes the row and (idempotently) enqueues the same setup job the worker would
 * have; if the provider errored or the server has been provisioning past a generous
 * deadline it marks the server `error` so it's a clear, retryable failure instead of
 * a silent dead-end.
 *
 * It does NOT touch the existing worker logic — it is purely a best-effort backstop.
 */
import { and, eq, ne } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { createProvider, type ProviderType } from '../providers';
import { getServerSetupQueue } from '../queue/queues';
import { wsManager } from '../lib/ws';
import { logger } from '../lib/logger';

/**
 * Servers that have been `provisioning` longer than this are considered failed and
 * are transitioned to `error`. Deliberately generous (well beyond the ~5 min poll
 * budget) so genuinely slow boots still get recovered rather than failed.
 */
const PROVISIONING_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

// Resolve the provider API token from the environment. Mirrors the same switch in
// queue/workers/server-status.worker.ts (kept local rather than shared on purpose,
// so the sweeper stays self-contained).
function getProviderToken(provider: ProviderType): string {
  switch (provider) {
    case 'hetzner':
      return process.env.HETZNER_API_TOKEN || '';
    case 'digitalocean':
      return process.env.DIGITALOCEAN_API_TOKEN || '';
    case 'aws':
      return process.env.AWS_ACCESS_KEY || '';
    default:
      return '';
  }
}

export interface ReconcileResult {
  /** Servers inspected (managed + still provisioning). */
  inspected: number;
  /** Servers promoted to `running` and handed off to setup. */
  recovered: number;
  /** Servers marked `error` (provider error or timed out). */
  failed: number;
}

/**
 * Sweep managed servers stuck at `provisioning` and drive each one forward.
 * Best-effort and failure-tolerant: every server is processed in its own try/catch
 * so a single bad row (or provider hiccup) never aborts the sweep.
 */
export async function reconcileProvisioningServers(): Promise<ReconcileResult> {
  const result: ReconcileResult = { inspected: 0, recovered: 0, failed: 0 };

  // Managed servers still provisioning (and not being deleted).
  const stuck = await db
    .select()
    .from(servers)
    .where(
      and(
        eq(servers.status, 'provisioning'),
        eq(servers.isManaged, true),
        ne(servers.status, 'deleting'),
      ),
    );

  result.inspected = stuck.length;
  if (stuck.length === 0) {
    return result;
  }

  for (const server of stuck) {
    try {
      const provider = server.provider as ProviderType;

      // No provider id yet → the create call hasn't returned an id; nothing to poll.
      if (!server.providerId) {
        continue;
      }

      const token = getProviderToken(provider);
      if (!token) {
        logger.warn(
          { serverId: server.id, provider },
          'Reconcile: no API token for provider, skipping server',
        );
        continue;
      }

      const providerInstance = createProvider(provider, token);
      const providerServer = await providerInstance.getServer(server.providerId);

      // ---- Provider says the VM is up: promote + hand off to setup ----
      if (providerServer.status === 'running' && providerServer.ipv4) {
        // Only re-trigger setup if it hasn't completed/failed yet.
        const setupInProgress =
          server.setupStatus === 'pending' || server.setupStatus === 'installing';

        await db
          .update(servers)
          .set({
            status: 'running',
            ipv4: providerServer.ipv4,
            ipv6: providerServer.ipv6,
            privateIp: providerServer.privateIp,
            ...(setupInProgress
              ? {
                  setupStatus: 'installing' as const,
                  statusMessage: 'Server is running, finishing setup...',
                }
              : {}),
            updatedAt: new Date(),
          })
          .where(eq(servers.id, server.id));

        // Enqueue the setup job EXACTLY like server-status.worker.ts does. The fixed
        // jobId (`server-setup-<id>`) makes BullMQ de-dupe, so even if the worker
        // already queued this we never double-queue.
        if (setupInProgress) {
          const setupQueue = getServerSetupQueue();
          await setupQueue.add(
            `server-setup-${server.id}`,
            {
              serverId: server.id,
              providerId: server.providerId,
              provider,
            },
            {
              jobId: `server-setup-${server.id}`,
              delay: 5000,
            },
          );
        }

        wsManager
          .publish(`server:${server.id}`, {
            type: 'server:status',
            data: {
              serverId: server.id,
              status: 'running',
              ipv4: providerServer.ipv4 || undefined,
            },
          })
          .catch(() => {});

        result.recovered++;
        logger.info(
          { serverId: server.id, provider, ipv4: providerServer.ipv4 },
          'Reconcile: recovered stuck server, now running and handed off to setup',
        );
        continue;
      }

      // ---- Terminal failure: provider errored, or provisioning past the deadline ----
      const createdAtMs = server.createdAt ? new Date(server.createdAt).getTime() : Date.now();
      const provisioningTooLong = Date.now() - createdAtMs > PROVISIONING_TIMEOUT_MS;

      if (providerServer.status === 'error' || provisioningTooLong) {
        await db
          .update(servers)
          .set({
            status: 'error',
            statusMessage:
              'Provisioning timed out — the server did not become ready. Please retry.',
            updatedAt: new Date(),
          })
          .where(eq(servers.id, server.id));

        wsManager
          .publish(`server:${server.id}`, {
            type: 'server:status',
            data: {
              serverId: server.id,
              status: 'error',
            },
          })
          .catch(() => {});

        result.failed++;
        logger.warn(
          {
            serverId: server.id,
            provider,
            providerStatus: providerServer.status,
            provisioningTooLong,
          },
          'Reconcile: server provisioning failed/timed out, marked error',
        );
        continue;
      }

      // Otherwise still booting within the deadline — leave it for the next sweep.
    } catch (err) {
      // Never let one server's failure abort the whole sweep.
      logger.error(
        { err, serverId: server.id },
        'Reconcile: failed to reconcile server, skipping',
      );
    }
  }

  return result;
}
