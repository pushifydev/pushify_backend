import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { organizations } from '../db/schema/organizations';
import { createProvider, type ProviderType } from '../providers';

function getProviderToken(provider: ProviderType): string {
  switch (provider) {
    case 'hetzner':
      return process.env.HETZNER_API_TOKEN || '';
    case 'digitalocean':
      return process.env.DIGITALOCEAN_API_TOKEN || '';
    default:
      return '';
  }
}
import { getEffectivePlanLimits } from '../lib/effective-plan-limits';
import { isUnlimited, type PlanType } from '../lib/plans';
import { logger } from '../lib/logger';
import type { Snapshot } from '../providers/cloud-provider.interface';

const AUTO_SNAPSHOT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export const serverSnapshotAutomationService = {
  async runScheduledSnapshots(): Promise<{ created: number; pruned: number; skipped: number }> {
    const rows = await db
      .select({
        server: servers,
        plan: organizations.plan,
        grandfatheredUntil: organizations.grandfatheredUntil,
        planLimitsOverride: organizations.planLimitsOverride,
      })
      .from(servers)
      .innerJoin(organizations, eq(servers.organizationId, organizations.id))
      .where(
        and(
          eq(servers.autoSnapshotEnabled, true),
          eq(servers.isManaged, true),
          eq(servers.provider, 'hetzner'),
          eq(servers.status, 'running'),
        ),
      );

    let created = 0;
    let pruned = 0;
    let skipped = 0;

    for (const row of rows) {
      try {
        const result = await this.processServer(row.server, {
          plan: (row.plan || 'free') as PlanType,
          grandfatheredUntil: row.grandfatheredUntil,
          planLimitsOverride: row.planLimitsOverride as Record<string, number | boolean> | null,
        });
        created += result.created ? 1 : 0;
        pruned += result.pruned;
        if (!result.created && result.pruned === 0) skipped++;
      } catch (error) {
        skipped++;
        logger.error({ err: error, serverId: row.server.id }, 'Auto snapshot failed for server');
      }
    }

    return { created, pruned, skipped };
  },

  async processServer(
    server: typeof servers.$inferSelect,
    org: {
      plan: PlanType;
      grandfatheredUntil: Date | null;
      planLimitsOverride: Record<string, number | boolean> | null;
    },
  ): Promise<{ created: boolean; pruned: number }> {
    if (!server.providerId) {
      return { created: false, pruned: 0 };
    }

    const limits = getEffectivePlanLimits(org);
    const maxSnapshots = limits.snapshotsPerServer;
    if (maxSnapshots <= 0) {
      return { created: false, pruned: 0 };
    }

    const apiToken = getProviderToken('hetzner');
    if (!apiToken) {
      return { created: false, pruned: 0 };
    }

    const provider = createProvider('hetzner', apiToken);
    let snapshots = await provider.listSnapshots(server.providerId);

    const hasCreating = snapshots.some((s) => s.status === 'creating');
    if (hasCreating) {
      return { created: false, pruned: 0 };
    }

    const now = Date.now();
    const lastAt = server.lastAutoSnapshotAt?.getTime() ?? 0;
    let created = false;

    if (now - lastAt >= AUTO_SNAPSHOT_INTERVAL_MS) {
      const label = `pushify-auto-${server.name}-${new Date().toISOString().slice(0, 10)}`;
      await provider.createSnapshot(server.providerId, label, 'Automatic weekly snapshot');
      await db
        .update(servers)
        .set({ lastAutoSnapshotAt: new Date(), updatedAt: new Date() })
        .where(eq(servers.id, server.id));
      created = true;
      logger.info({ serverId: server.id, name: server.name }, 'Automatic server snapshot started');
      snapshots = await provider.listSnapshots(server.providerId);
    }

    const pruned = await this.pruneSnapshots(provider, snapshots, maxSnapshots);
    return { created, pruned };
  },

  async pruneSnapshots(
    provider: ReturnType<typeof createProvider>,
    snapshots: Snapshot[],
    maxSnapshots: number,
  ): Promise<number> {
    if (isUnlimited(maxSnapshots)) return 0;

    const available = snapshots
      .filter((s) => s.status === 'available')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

    let pruned = 0;
    while (available.length > maxSnapshots) {
      const oldest = available.shift();
      if (!oldest) break;
      try {
        await provider.deleteSnapshot(oldest.id);
        pruned++;
        logger.info({ snapshotId: oldest.id }, 'Pruned old server snapshot');
      } catch (error) {
        logger.error({ err: error, snapshotId: oldest.id }, 'Failed to prune snapshot');
        break;
      }
    }

    return pruned;
  },

  async setAutoSnapshotEnabled(
    serverId: string,
    organizationId: string,
    enabled: boolean,
  ): Promise<void> {
    const limits = await this.getOrgSnapshotLimit(organizationId);
    if (enabled && limits <= 0) {
      throw new Error('PLAN_SNAPSHOTS_NOT_ALLOWED');
    }

    await db
      .update(servers)
      .set({
        autoSnapshotEnabled: enabled,
        updatedAt: new Date(),
      })
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)));
  },

  async getOrgSnapshotLimit(organizationId: string): Promise<number> {
    const [org] = await db
      .select({
        plan: organizations.plan,
        grandfatheredUntil: organizations.grandfatheredUntil,
        planLimitsOverride: organizations.planLimitsOverride,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);

    if (!org) return 0;

    return getEffectivePlanLimits({
      plan: (org.plan || 'free') as PlanType,
      grandfatheredUntil: org.grandfatheredUntil,
      planLimitsOverride: org.planLimitsOverride as Record<string, number | boolean> | null,
    }).snapshotsPerServer;
  },
};
