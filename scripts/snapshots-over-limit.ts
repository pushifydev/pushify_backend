/**
 * READ-ONLY: which managed servers have more snapshots than their plan allows. Nothing is changed.
 * The limit was not enforced before (snapshots were never listed); these servers keep what they
 * have and are only refused new snapshots until they are under the limit.
 *
 *   npm run snapshots:over-limit
 *
 * Run on the API host: it reads the PRODUCTION database (plans) and Hetzner (snapshot counts).
 */
import { and, eq, isNotNull } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { organizations, servers } from '../src/db/schema';
import { env } from '../src/config/env';
import { createProvider } from '../src/providers';
import { getEffectivePlanLimits } from '../src/lib/effective-plan-limits';
import { isUnlimited, type PlanType } from '../src/lib/plans';

async function main() {
  if (!env.HETZNER_API_TOKEN) throw new Error('HETZNER_API_TOKEN is not set');
  const provider = createProvider('hetzner', env.HETZNER_API_TOKEN);
  const all = await provider.listSnapshots();
  const byServer = new Map<string, number>();
  // listSnapshots() without an id returns every snapshot; count them per server id.
  const ids = await Promise.all(
    [...new Set((await db.select({ providerId: servers.providerId }).from(servers).where(isNotNull(servers.providerId))).map((s) => s.providerId!))].map(
      async (pid) => [pid, (await provider.listSnapshotIdsCreatedFrom!(pid)).length] as const,
    ),
  );
  for (const [pid, n] of ids) byServer.set(pid, n);

  const rows = await db
    .select({
      serverId: servers.id,
      serverName: servers.name,
      providerId: servers.providerId,
      orgId: organizations.id,
      orgName: organizations.name,
      plan: organizations.plan,
      grandfatheredUntil: organizations.grandfatheredUntil,
      planLimitsOverride: organizations.planLimitsOverride,
    })
    .from(servers)
    .innerJoin(organizations, eq(organizations.id, servers.organizationId))
    .where(and(eq(servers.isManaged, true), isNotNull(servers.providerId)));

  const over = rows
    .map((r) => {
      const limit = getEffectivePlanLimits({
        plan: (r.plan || 'free') as PlanType,
        grandfatheredUntil: r.grandfatheredUntil,
        planLimitsOverride: r.planLimitsOverride as Record<string, number | boolean> | null,
      }).snapshotsPerServer;
      return { ...r, limit, count: byServer.get(r.providerId!) ?? 0 };
    })
    .filter((r) => !isUnlimited(r.limit) && r.count > r.limit);

  console.log(`Snapshots in the account: ${all.length}`);
  console.log(`Managed servers over their snapshot limit: ${over.length}, in ${new Set(over.map((r) => r.orgId)).size} organization(s)`);
  for (const r of over) {
    console.log(`  ${r.orgName} (${r.plan})  ${r.serverName}  ${r.count} snapshots, limit ${r.limit}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
