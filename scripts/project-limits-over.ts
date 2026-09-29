/**
 * READ-ONLY: projects that already hold more cron jobs, volumes or workers than PROJECT_LIMITS
 * allows, or cron jobs whose timeout is outside the allowed range. Before beta.96 the pushify.yaml
 * schema allowed 20 cron jobs, 5–3600 s timeouts and 10 volumes, and the deploy sync did not count
 * rows added in the dashboard, so such rows can exist. Nothing is changed or deleted.
 *
 *   npm run limits:over
 *
 * Run on the API host (it reads the PRODUCTION database). A project listed here whose repo still
 * declares the old amounts will see "pushify.yaml ignored" in its next deploy log.
 */
import { count, eq, gt, lt, or, sql } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { organizations, projects, scheduledTasks, projectVolumes, projectWorkers } from '../src/db/schema';
import { PROJECT_LIMITS } from '../src/lib/project-limits';

const TASK = PROJECT_LIMITS.scheduledTasks;

async function overCount(table: typeof scheduledTasks | typeof projectVolumes | typeof projectWorkers, max: number) {
  return db
    .select({ project: projects.slug, org: organizations.name, n: count() })
    .from(table)
    .innerJoin(projects, eq(projects.id, table.projectId))
    .innerJoin(organizations, eq(organizations.id, projects.organizationId))
    .groupBy(projects.slug, organizations.name)
    .having(sql`count(*) > ${max}`);
}

async function main() {
  const sections: Array<[string, number, Awaited<ReturnType<typeof overCount>>]> = [
    ['cron jobs', TASK.maxPerProject, await overCount(scheduledTasks, TASK.maxPerProject)],
    ['volumes', PROJECT_LIMITS.volumes.maxPerProject, await overCount(projectVolumes, PROJECT_LIMITS.volumes.maxPerProject)],
    ['workers', PROJECT_LIMITS.workers.maxPerProject, await overCount(projectWorkers, PROJECT_LIMITS.workers.maxPerProject)],
  ];
  for (const [label, max, rows] of sections) {
    console.log(`Projects with more than ${max} ${label}: ${rows.length}`);
    for (const r of rows) console.log(`  ${r.org} / ${r.project}  ${r.n}`);
  }

  const timeouts = await db
    .select({ project: projects.slug, org: organizations.name, task: scheduledTasks.name, timeout: scheduledTasks.timeoutSeconds })
    .from(scheduledTasks)
    .innerJoin(projects, eq(projects.id, scheduledTasks.projectId))
    .innerJoin(organizations, eq(organizations.id, projects.organizationId))
    .where(or(lt(scheduledTasks.timeoutSeconds, TASK.minTimeoutSeconds), gt(scheduledTasks.timeoutSeconds, TASK.maxTimeoutSeconds)));
  console.log(`Cron jobs with a timeout outside ${TASK.minTimeoutSeconds}-${TASK.maxTimeoutSeconds} s: ${timeouts.length}`);
  for (const t of timeouts) console.log(`  ${t.org} / ${t.project}  ${t.task}  ${t.timeout}s`);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeDatabasePool());
