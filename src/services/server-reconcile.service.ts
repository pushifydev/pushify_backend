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
import { and, eq, ne, inArray, or, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { projects } from '../db/schema/projects';
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

/**
 * Servers that are `running` but whose setup never finished (health check never
 * confirmed) longer than this are marked `failed`. Generous so slow cloud-init
 * (Docker + Nginx install) still completes rather than being failed prematurely.
 */
const SETUP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Poll the server's `/health` endpoint (served by cloud-init's Nginx once setup is
 * done). Mirrors checkServerHealth() in queue/workers/server-setup.worker.ts.
 */
async function checkServerHealth(ipv4: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(`http://${ipv4}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      const text = await response.text();
      return text.includes('OK');
    }
    return false;
  } catch {
    return false;
  }
}

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
  /** Running servers whose setup the sweep confirmed healthy → completed. */
  setupCompleted: number;
  /** Running servers whose setup timed out → marked failed. */
  setupFailed: number;
}

/**
 * Sweep managed servers stuck at `provisioning` and drive each one forward.
 * Best-effort and failure-tolerant: every server is processed in its own try/catch
 * so a single bad row (or provider hiccup) never aborts the sweep.
 */
export async function reconcileProvisioningServers(): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    inspected: 0,
    recovered: 0,
    failed: 0,
    setupCompleted: 0,
    setupFailed: 0,
  };

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

  // ---- Setup stage: managed servers that reached `running` but whose setup never
  // finished (setupStatus still pending/installing). The one-shot server-setup job
  // can die on a worker restart, leaving the row stuck even after /health is up — so
  // re-check health here and finish (or fail) the setup independently. ----
  const installing = await db
    .select()
    .from(servers)
    .where(
      and(
        eq(servers.status, 'running'),
        eq(servers.isManaged, true),
        inArray(servers.setupStatus, ['pending', 'installing']),
      ),
    );

  for (const server of installing) {
    try {
      if (!server.ipv4) continue;

      const healthy = await checkServerHealth(server.ipv4);

      if (healthy) {
        await db
          .update(servers)
          .set({
            setupStatus: 'completed',
            statusMessage: 'Server setup completed successfully',
            updatedAt: new Date(),
          })
          .where(eq(servers.id, server.id));

        wsManager
          .publish(`server:${server.id}`, {
            type: 'server:setup',
            data: {
              serverId: server.id,
              status: 'running',
              setupStatus: 'completed',
              statusMessage: 'Server setup completed successfully',
            },
          })
          .catch(() => {});

        // Notify the org that the server is ready (best-effort, mirrors the setup worker).
        void (async () => {
          try {
            const { resolveBillingNotifyEmail } = await import('../lib/billing-notify');
            const { sendServerReadyEmail } = await import('../lib/email');
            const to = await resolveBillingNotifyEmail(server.organizationId);
            if (to) await sendServerReadyEmail(to, server.name, server.id, 'en');
          } catch {
            // best-effort
          }
        })();

        result.setupCompleted++;
        logger.info(
          { serverId: server.id, ipv4: server.ipv4 },
          'Reconcile: setup health OK, marked completed',
        );
        continue;
      }

      // Not healthy yet — only fail it once well past a generous deadline.
      const createdAtMs = server.createdAt ? new Date(server.createdAt).getTime() : Date.now();
      if (Date.now() - createdAtMs > SETUP_TIMEOUT_MS) {
        await db
          .update(servers)
          .set({
            setupStatus: 'failed',
            statusMessage: 'Server setup timed out - health check not responding',
            updatedAt: new Date(),
          })
          .where(eq(servers.id, server.id));

        wsManager
          .publish(`server:${server.id}`, {
            type: 'server:setup',
            data: {
              serverId: server.id,
              status: 'running',
              setupStatus: 'failed',
              statusMessage: 'Server setup timed out - health check not responding',
            },
          })
          .catch(() => {});

        result.setupFailed++;
        logger.warn(
          { serverId: server.id },
          'Reconcile: setup timed out, marked failed',
        );
      }
      // Otherwise still installing within the deadline — leave it for the next sweep.
    } catch (err) {
      logger.error(
        { err, serverId: server.id },
        'Reconcile: failed to reconcile setup, skipping',
      );
    }
  }

  return result;
}

/**
 * GC: remove orphaned project deployments left behind on the LOCAL (shared Pushify) host.
 *
 * When a free-tier project is moved to the user's own server (`project.serverId` is set) or
 * deleted, its container + built images can linger on the shared host and waste disk. This
 * sweep tears down any local `pushify-<slug>` deployment whose project no longer belongs
 * here. Safe by construction: it only ever acts on projects that have a remote `serverId`
 * (so they must NOT have a local deployment) or are deleted — never a live local project.
 * Cheap: snapshots local containers + image repos once, then matches against the DB.
 */
export async function gcOrphanedLocalDeployments(): Promise<{ candidates: number; removed: number }> {
  const result = { candidates: 0, removed: 0 };

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const { buildRemoteTeardownScript } = await import('../lib/project-remote-cleanup');
  const execAsync = promisify(exec);

  // Snapshot what Pushify actually has on the local host (once).
  let localContainers = new Set<string>();
  let localImageRepos = new Set<string>();
  try {
    const c = await execAsync(`docker ps -a --format '{{.Names}}' | grep -E '^pushify-' || true`);
    localContainers = new Set(c.stdout.trim().split('\n').filter(Boolean));
    const i = await execAsync(`docker images --format '{{.Repository}}' | grep -E '^pushify/' || true`);
    localImageRepos = new Set(i.stdout.trim().split('\n').filter(Boolean));
  } catch {
    return result; // docker not available locally → nothing to GC
  }
  if (localContainers.size === 0 && localImageRepos.size === 0) return result;

  // Projects that must NOT have a local deployment: moved to a server, or deleted.
  const candidates = await db
    .select({ slug: projects.slug, settings: projects.settings, status: projects.status })
    .from(projects)
    .where(or(isNotNull(projects.serverId), eq(projects.status, 'deleted')));

  for (const p of candidates) {
    // Only act when a matching local artifact actually exists (exact names — no prefix
    // globbing — so we never touch a different project that merely shares a slug prefix).
    const hasContainer =
      localContainers.has(`pushify-${p.slug}`) ||
      localContainers.has(`pushify-${p.slug}-blue`) ||
      localContainers.has(`pushify-${p.slug}-green`) ||
      localContainers.has(`pushify-${p.slug}-db`);
    const hasImage = localImageRepos.has(`pushify/${p.slug}`);
    if (!hasContainer && !hasImage) continue;

    result.candidates++;
    try {
      const isCompose =
        (p.settings as Record<string, unknown> | null)?.deploymentType === 'docker-compose';
      // buildRemoteTeardownScript removes containers + images + nginx vhost + project dir.
      await execAsync(buildRemoteTeardownScript(p.slug, !!isCompose)).catch(() => {});
      result.removed++;
      logger.info(
        { slug: p.slug, reason: p.status === 'deleted' ? 'deleted' : 'moved-to-server' },
        'GC: removed orphaned local deployment',
      );
    } catch (err) {
      logger.warn({ slug: p.slug, err }, 'GC: orphaned local deployment cleanup failed');
    }
  }

  return result;
}
