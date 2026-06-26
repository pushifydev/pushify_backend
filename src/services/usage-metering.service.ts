import { eq, and, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizationMonthlyUsage } from '../db/schema/usage';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { metricsRepository } from '../repositories/metrics.repository';
import type { NewContainerMetric } from '../db/schema';
import { getImagesFootprintBytes } from '../lib/docker-disk-usage';
import { decrypt } from '../lib/encryption';
import { SSHClient } from '../utils/ssh';
import { logger } from '../lib/logger';

export const BYTES_PER_GB = 1024 ** 3;

function startOfUtcMonth(date = new Date()): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function bytesToGbCeil(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.ceil(bytes / BYTES_PER_GB);
}

type TrafficMeteringState = {
  periodKey: string;
  lastBytes: number;
};

function utcMonthKey(date = new Date()): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function getOutgoingFromProviderData(providerData: unknown): number | null {
  if (!providerData || typeof providerData !== 'object') return null;
  const traffic = (providerData as Record<string, unknown>).traffic;
  if (!traffic || typeof traffic !== 'object') return null;
  const outgoing = (traffic as Record<string, unknown>).outgoing;
  return typeof outgoing === 'number' && outgoing >= 0 ? outgoing : null;
}

export const usageMeteringService = {
  startOfUtcMonth,

  bytesToGbCeil,

  async getOrCreateMonthlyRow(organizationId: string, periodStart = startOfUtcMonth()) {
    const [existing] = await db
      .select()
      .from(organizationMonthlyUsage)
      .where(
        and(
          eq(organizationMonthlyUsage.organizationId, organizationId),
          eq(organizationMonthlyUsage.periodStart, periodStart),
        ),
      )
      .limit(1);

    if (existing) return existing;

    const [created] = await db
      .insert(organizationMonthlyUsage)
      .values({
        organizationId,
        periodStart,
      })
      .returning();

    return created;
  },

  async addBandwidthBytes(organizationId: string, deltaBytes: number): Promise<void> {
    if (deltaBytes <= 0) return;

    const periodStart = startOfUtcMonth();
    const row = await this.getOrCreateMonthlyRow(organizationId, periodStart);

    await db
      .update(organizationMonthlyUsage)
      .set({
        bandwidthBytes: row.bandwidthBytes + deltaBytes,
        updatedAt: new Date(),
      })
      .where(eq(organizationMonthlyUsage.id, row.id));
  },

  async observeStorageBytes(organizationId: string, bytes: number): Promise<void> {
    if (bytes <= 0) return;

    const periodStart = startOfUtcMonth();
    const row = await this.getOrCreateMonthlyRow(organizationId, periodStart);

    if (bytes <= row.storageBytesPeak) return;

    await db
      .update(organizationMonthlyUsage)
      .set({
        storageBytesPeak: bytes,
        updatedAt: new Date(),
      })
      .where(eq(organizationMonthlyUsage.id, row.id));
  },

  /**
   * Raw `storageBytesPeak` (bytes) for the current period, 0 if no row exists yet.
   * Used by quota ENFORCEMENT so we compare real bytes against `limitGb * BYTES_PER_GB`
   * instead of the display-oriented ceil'd GB (which rounded any storage > 0 up to >= 1GB).
   */
  async getMonthlyStorageBytes(organizationId: string): Promise<number> {
    const periodStart = startOfUtcMonth();
    const [row] = await db
      .select({ storageBytesPeak: organizationMonthlyUsage.storageBytesPeak })
      .from(organizationMonthlyUsage)
      .where(
        and(
          eq(organizationMonthlyUsage.organizationId, organizationId),
          eq(organizationMonthlyUsage.periodStart, periodStart),
        ),
      )
      .limit(1);

    return row?.storageBytesPeak ?? 0;
  },

  async getMonthlyUsageGb(organizationId: string): Promise<{
    storageGb: number;
    bandwidthGb: number;
  }> {
    const periodStart = startOfUtcMonth();
    const [row] = await db
      .select()
      .from(organizationMonthlyUsage)
      .where(
        and(
          eq(organizationMonthlyUsage.organizationId, organizationId),
          eq(organizationMonthlyUsage.periodStart, periodStart),
        ),
      )
      .limit(1);

    return {
      storageGb: bytesToGbCeil(row?.storageBytesPeak ?? 0),
      bandwidthGb: bytesToGbCeil(row?.bandwidthBytes ?? 0),
    };
  },

  /**
   * After metrics insert, attribute egress deltas to the organization.
   */
  /**
   * Merge Hetzner monthly outgoing_traffic deltas into org bandwidth and persist metering cursor in providerData.
   */
  async mergeHetznerTrafficProviderData(
    organizationId: string,
    providerData: unknown,
  ): Promise<unknown> {
    const outgoing = getOutgoingFromProviderData(providerData);
    if (outgoing == null) return providerData;

    const base =
      providerData && typeof providerData === 'object'
        ? { ...(providerData as Record<string, unknown>) }
        : {};

    const periodKey = utcMonthKey();
    const prev = base.trafficMetering as TrafficMeteringState | undefined;
    let delta = 0;

    if (!prev || prev.periodKey !== periodKey) {
      delta = 0;
    } else if (outgoing < prev.lastBytes) {
      delta = outgoing;
    } else {
      delta = outgoing - prev.lastBytes;
    }

    if (delta > 0) {
      await this.addBandwidthBytes(organizationId, delta);
    }

    base.trafficMetering = { periodKey, lastBytes: outgoing } satisfies TrafficMeteringState;
    return base;
  },

  /**
   * Poll each organization's OWN Docker image footprint (on running servers and the local
   * host) and update the monthly storage peak. Footprint is measured per-org from the org's
   * project image repositories (`pushify/<slug>`), NOT the whole-host docker disk — so
   * co-tenants on a shared host are not over-counted for each other's images.
   */
  async syncDockerDiskUsageFromServers(): Promise<void> {
    const runningServers = await db
      .select({
        id: servers.id,
        organizationId: servers.organizationId,
        ipv4: servers.ipv4,
        sshPrivateKey: servers.sshPrivateKey,
      })
      .from(servers)
      .where(inArray(servers.status, ['running', 'rebooting']));

    const orgTotals = new Map<string, number>();

    for (const server of runningServers) {
      // Image repos for this server's projects → `pushify/<slug>` prefixes.
      const serverProjects = await db
        .select({ slug: projects.slug })
        .from(projects)
        .where(eq(projects.serverId, server.id));
      const repos = serverProjects.map((p) => `pushify/${p.slug}`);
      if (repos.length === 0) continue;

      let bytes = 0;
      if (server.ipv4 && server.sshPrivateKey) {
        let ssh: SSHClient | null = null;
        try {
          ssh = new SSHClient();
          await ssh.connect({
            host: server.ipv4,
            port: 22,
            username: 'root',
            privateKey: decrypt(server.sshPrivateKey),
          });
          bytes = await getImagesFootprintBytes(ssh, repos);
        } catch (error) {
          logger.warn({ err: error, serverId: server.id }, 'Docker disk sync skipped for server');
        } finally {
          ssh?.disconnect();
        }
      }
      if (bytes > 0) {
        orgTotals.set(
          server.organizationId,
          (orgTotals.get(server.organizationId) ?? 0) + bytes,
        );
      }
    }

    // Local host: measure EACH org's own image footprint (its local-host project slugs),
    // attributing only that org's bytes — never the whole local docker disk to everyone.
    const localHostProjects = await db
      .select({ organizationId: projects.organizationId, slug: projects.slug })
      .from(projects)
      .where(and(eq(projects.status, 'active'), isNull(projects.serverId)));

    const localReposByOrg = new Map<string, string[]>();
    for (const p of localHostProjects) {
      const list = localReposByOrg.get(p.organizationId) ?? [];
      list.push(`pushify/${p.slug}`);
      localReposByOrg.set(p.organizationId, list);
    }

    for (const [organizationId, repos] of localReposByOrg) {
      try {
        const bytes = await getImagesFootprintBytes(null, repos);
        if (bytes > 0) {
          orgTotals.set(organizationId, (orgTotals.get(organizationId) ?? 0) + bytes);
        }
      } catch (error) {
        logger.warn({ err: error, organizationId }, 'Local docker disk sync failed');
      }
    }

    for (const [organizationId, bytes] of orgTotals) {
      await this.observeStorageBytes(organizationId, bytes);
    }
  },

  async recordBandwidthFromMetrics(metrics: NewContainerMetric[]): Promise<void> {
    const projectOrgCache = new Map<string, string>();

    for (const metric of metrics) {
      if (!metric.deploymentId) continue;

      let orgId = projectOrgCache.get(metric.projectId);
      if (!orgId) {
        const [project] = await db
          .select({ organizationId: projects.organizationId })
          .from(projects)
          .where(eq(projects.id, metric.projectId))
          .limit(1);
        if (!project) continue;
        orgId = project.organizationId;
        projectOrgCache.set(metric.projectId, orgId);
      }

      const previous = await metricsRepository.findLatestNetworkTxByDeployment(metric.deploymentId);

      const prevTx = previous?.networkTxBytes ?? 0;
      let delta = metric.networkTxBytes - prevTx;
      if (delta < 0) {
        // Container recreated — counter reset
        delta = metric.networkTxBytes;
      }
      if (delta > 0) {
        await this.addBandwidthBytes(orgId, delta);
      }
    }
  },
};
