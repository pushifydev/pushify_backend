/**
 * READ-ONLY report: scan every live project with the Acceptable Use rules (config/abuse-rules.yaml)
 * and print what would be flagged. Nothing is written — no flag, no suspension, no email — and no
 * project is touched. Each repository is cloned into a temporary directory at the deployed commit
 * and deleted again; image projects are matched by their image reference; the latest build log
 * (already secret-masked) is scanned too. Environment variables are never read.
 *
 *   npm run abuse:scan -- --dry-run              projects the hosted-service rules cover
 *   npm run abuse:scan -- --dry-run --all        also BYOS projects on their own domains (for information)
 *   npm run abuse:scan -- --dry-run --project <slug>
 *   npm run abuse:scan -- --enqueue              put flagged covered projects into the admin review
 *                                                queue (and email the operators); never suspends
 *
 * Run on the API host: it reads the production database and clones with the projects' Git credentials.
 */
import { and, desc, eq, inArray } from 'drizzle-orm';
import { db, closeDatabasePool } from '../src/db';
import { projects, deployments, organizations } from '../src/db/schema';
import { loadAbuseRules, abuseRulesPath } from '../src/lib/abuse/rules';
import { readRepositoryForScan, scanForAbuse, scoreReasons, type ScanResult } from '../src/lib/abuse/scan';
import { cloneRepository, cleanupRepository } from '../src/workers/git';
import { getProjectGitAccessToken } from '../src/services/git-provider-access.service';
import { abuseService, projectIsCovered } from '../src/services/abuse.service';
import { closeQueues } from '../src/lib/queue';

const args = process.argv.slice(2);
const includeAll = args.includes('--all');
const enqueue = args.includes('--enqueue');
const onlySlug = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;

interface Row {
  slug: string;
  org: string;
  covered: boolean;
  result: ScanResult | null;
  note: string;
}

async function scanProject(p: typeof projects.$inferSelect): Promise<{ result: ScanResult | null; note: string }> {
  const rules = loadAbuseRules();
  const [latest] = await db
    .select({ commitHash: deployments.commitHash, branch: deployments.branch, buildLogs: deployments.buildLogs })
    .from(deployments)
    .where(and(eq(deployments.projectId, p.id), inArray(deployments.status, ['running'])))
    .orderBy(desc(deployments.createdAt))
    .limit(1);

  const image = p.dockerImage?.trim() || null;
  let source: Awaited<ReturnType<typeof readRepositoryForScan>> = {};
  let note = '';

  if (!image && p.gitRepoUrl) {
    let workDir: string | null = null;
    try {
      const credential = await getProjectGitAccessToken(p.id).catch(() => null);
      const clone = await cloneRepository({
        repoUrl: p.gitRepoUrl,
        branch: latest?.branch || p.gitBranch || undefined,
        commit: latest?.commitHash ?? undefined,
        accessToken: credential?.token,
      });
      workDir = clone.workDir;
      source = await readRepositoryForScan(workDir, rules);
      note = `${source.files?.length ?? 0} files read`;
    } catch (err) {
      note = `source not scanned (${err instanceof Error ? err.message.split('\n')[0].slice(0, 80) : 'clone failed'})`;
    } finally {
      if (workDir) await cleanupRepository(workDir).catch(() => undefined);
    }
  } else if (image) {
    note = `image ${image}`;
  } else {
    note = 'no repository or image';
  }

  const fromSource = scanForAbuse({ ...source, image }, rules);
  const fromLog = scanForAbuse({ buildLog: latest?.buildLogs ?? null }, rules);
  return { result: scoreReasons([...fromSource.reasons, ...fromLog.reasons], rules), note };
}

async function main() {
  if (args.includes('--dry-run') === enqueue) {
    console.error('Choose one: --dry-run (report only) or --enqueue (queue flagged projects for review).');
    process.exitCode = 2;
    return;
  }
  const rules = loadAbuseRules();
  console.log(`Rules: ${abuseRulesPath()} (${rules.rules.length} rules, flag score ${rules.policy.flagScore})`);
  console.log(
    enqueue
      ? 'ENQUEUE — flagged covered projects go to the review queue; nothing is suspended or stopped.\n'
      : 'DRY RUN — nothing is written, no project is changed.\n',
  );

  const live = await db
    .select({ project: projects, org: organizations.name })
    .from(projects)
    .innerJoin(organizations, eq(organizations.id, projects.organizationId))
    .where(eq(projects.status, 'active'));

  const rows: Row[] = [];
  for (const { project, org } of live) {
    if (onlySlug && project.slug !== onlySlug) continue;
    const covered = await projectIsCovered(project.id);
    if (!covered && !includeAll) continue;
    const { result, note } = await scanProject(project);
    rows.push({ slug: project.slug, org, covered, result, note });
    if (enqueue && covered && result?.flagged) {
      const queued = await abuseService.recordFinding({
        projectId: project.id,
        organizationId: project.organizationId,
        source: 'deploy_scan',
        result,
      });
      console.log(`  queued ${project.slug} (${queued?.created ? 'new flag' : 'updated open flag'})`);
    }
  }

  const flagged = rows.filter((r) => r.result?.flagged);
  const notable = rows.filter((r) => !r.result?.flagged && (r.result?.reasons.some((x) => x.strength !== 'weak') ?? false));

  console.log(`Projects scanned: ${rows.length}${includeAll ? ' (including BYOS on own domains)' : ' (covered by the hosted-service rules)'}`);
  console.log(`Would be flagged: ${flagged.length}`);
  console.log(`Below the threshold but with a medium/strong signal: ${notable.length}\n`);

  for (const r of [...flagged, ...notable]) {
    const res = r.result!;
    console.log(`${res.flagged ? 'FLAG ' : 'watch'}  ${r.org} / ${r.slug}  score ${res.score}  ${r.covered ? 'covered' : 'NOT covered (BYOS + own domain)'}  — ${r.note}`);
    for (const reason of res.reasons) {
      const where = reason.file ? ` (${reason.file}${reason.line ? `:${reason.line}` : ''})` : '';
      console.log(`         [${reason.strength}] ${reason.ruleId}: ${reason.message}${where}`);
    }
  }
  const unscanned = rows.filter((r) => r.note.startsWith('source not scanned'));
  if (unscanned.length) {
    console.log(`\nSource could not be scanned for ${unscanned.length} project(s) (build log and image still were):`);
    for (const r of unscanned) console.log(`  ${r.org} / ${r.slug} — ${r.note}`);
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    // --enqueue emails the operators through the Redis queue (fire-and-forget). Give those
    // sends a moment, then close the queue connection too — an open one keeps the process alive.
    if (enqueue) await new Promise((resolve) => setTimeout(resolve, 2000));
    await closeQueues().catch(() => undefined);
    await closeDatabasePool();
    process.exit(process.exitCode ?? 0);
  });
