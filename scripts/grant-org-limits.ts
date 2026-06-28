/**
 * Internal / comp grant tool — give an organization plan entitlements WITHOUT going through
 * Stripe. Use it for your own operator org (e.g. `servers: 1` so you can add the platform
 * runner) or to comp a partner. Sets `organizations.plan` and/or `planLimitsOverride`, which
 * `getEffectivePlanLimits` merges on top of the plan's base limits — so the org keeps its real
 * plan/billing state but gains the granted capacity.
 *
 *   npm run grant-org -- --org <id> --servers 1                 # raise just the server limit
 *   npm run grant-org -- --org <id> --plan hobby                # set a comp plan
 *   npm run grant-org -- --org <id> --override '{"servers":2,"projects":20}'
 *
 * Find your org id in the dashboard URL or the organizations table. Run on the API host.
 */
import { eq } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { organizations } from '../src/db/schema/organizations';
import { logger } from '../src/lib/logger';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const orgId = arg('--org');
  if (!orgId) throw new Error('--org <id> is required');

  const plan = arg('--plan');
  const serversStr = arg('--servers');
  const overrideJson = arg('--override');

  const [org] = await db
    .select()
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) throw new Error(`Organization ${orgId} not found`);

  const update: Record<string, unknown> = { updatedAt: new Date() };

  if (plan) update.plan = plan; // the DB enum rejects an invalid plan name

  // Merge any limit overrides on top of the org's existing ones (don't clobber).
  const existing = (org.planLimitsOverride || {}) as Record<string, number | boolean>;
  const merged: Record<string, number | boolean> = { ...existing };
  if (serversStr !== undefined) merged.servers = parseInt(serversStr, 10);
  if (overrideJson) Object.assign(merged, JSON.parse(overrideJson));
  const overrideChanged = serversStr !== undefined || overrideJson;
  if (overrideChanged) update.planLimitsOverride = merged;

  if (!plan && !overrideChanged) {
    throw new Error('Nothing to change — pass --plan and/or --servers / --override');
  }

  await db.update(organizations).set(update).where(eq(organizations.id, orgId));

  logger.info(
    {
      orgId,
      plan: (update.plan as string) ?? org.plan,
      planLimitsOverride: update.planLimitsOverride ?? org.planLimitsOverride,
    },
    'Org limits granted (comp)',
  );
}

main()
  .then(async () => {
    await closeDatabasePool();
    process.exit(0);
  })
  .catch(async (err) => {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'grant-org failed');
    await closeDatabasePool();
    process.exit(1);
  });
