import { eq, and, inArray, isNull } from 'drizzle-orm';
import { db } from '../db';
import { organizationMonthlyUsage } from '../db/schema/usage';
import { projects } from '../db/schema/projects';
import { servers } from '../db/schema/servers';
import { metricsRepository } from '../repositories/metrics.repository';
import type { NewContainerMetric } from '../db/schema';
import { getDockerSystemDiskBytes } from '../lib/docker-disk-usage';
import { decrypt } from '../lib/encryption';
import { SSHClient } from '../utils/ssh';
import { logger } from '../lib/logger';

const BYTES_PER_GB = 1024 ** 3;

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

  /** Add deploy artifact size to running storage total (peak field holds cumulative deploy storage). */
  async addDeployStorageBytes(organizationId: string, artifactBytes: number): Promise<void> {
    if (artifactBytes <= 0) return;

    const periodStart = startOfUtcMonth();
    const row = await this.getOrCreateMonthlyRow(organizationId, periodStart);
    const next = row.storageBytesPeak + artifactBytes;

    await db
      .update(organizationMonthlyUsage)
      .set({
        storageBytesPeak: next,
        updatedAt: new Date(),
      })
      .where(eq(organizationMonthlyUsage.id, row.id));
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
   * Poll Docker disk usage on running servers (and local host) and update monthly storage peak.
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
          bytes = await getDockerSystemDiskBytes(ssh);
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

    const localHostOrgs = await db
      .selectDistinct({ organizationId: projects.organizationId })
      .from(projects)
      .where(and(eq(projects.status, 'active'), isNull(projects.serverId)));

    if (localHostOrgs.length > 0) {
      try {
        const bytes = await getDockerSystemDiskBytes(null);
        if (bytes > 0) {
          for (const row of localHostOrgs) {
            orgTotals.set(
              row.organizationId,
              (orgTotals.get(row.organizationId) ?? 0) + bytes,
            );
          }
        }
      } catch (error) {
        logger.warn({ err: error }, 'Local docker disk sync failed');
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
