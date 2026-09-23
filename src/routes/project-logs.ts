import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { projectLogContainers, searchProjectLogs } from '../workers/log-collector';
import { organizationRepository } from '../repositories/organization.repository';
import { projectRepository } from '../repositories/project.repository';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import { assertMemberProjectScope } from '../lib/member-project-scope';
import { getEffectivePlanLimits } from '../lib/effective-plan-limits';
import type { AppEnv } from '../types';

const projectLogsRouter = new Hono<AppEnv>();

projectLogsRouter.use('*', authMiddleware);

/** Membership + project scope for every route here; returns the project. */
async function authorize(c: Context<AppEnv>) {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
  }
  const project = await projectRepository.findById(projectId);
  if (!project || project.organizationId !== organizationId) {
    throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
  }
  await assertMemberProjectScope(membership, organizationId, userId, projectId, locale);
  return { projectId, project, organizationId };
}

/** How far back the history actually goes for this organization — the UI says so instead of "7 days". */
async function retentionDays(organizationId: string): Promise<number> {
  const org = await organizationRepository.findById(organizationId);
  if (!org) return 7;
  return getEffectivePlanLimits({
    plan: org.plan ?? 'free',
    grandfatheredUntil: org.grandfatheredUntil,
    planLimitsOverride: org.planLimitsOverride,
  }).logRetentionDays;
}

/** `?from=`/`?to=` as ISO strings or epoch millis; anything unparseable is simply ignored. */
function parseDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = /^\d+$/.test(value) ? new Date(Number(value)) : new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function searchOptions(c: Context<AppEnv>, maxCap: number) {
  const logTypeRaw = c.req.query('logType');
  const logType: 'stdout' | 'stderr' | undefined =
    logTypeRaw === 'stdout' || logTypeRaw === 'stderr' ? logTypeRaw : undefined;
  const rawLimit = parseInt(c.req.query('limit') || '500', 10);
  return {
    query: c.req.query('q') || undefined,
    logType,
    containerName: c.req.query('container') || undefined,
    from: parseDate(c.req.query('from')),
    to: parseDate(c.req.query('to')),
    maxLines: Number.isFinite(rawLimit) ? Math.min(maxCap, Math.max(1, rawLimit)) : Math.min(500, maxCap),
  };
}

// Search a project's persisted container logs (logs explorer history mode)
projectLogsRouter.get('/:projectId/logs/search', async (c) => {
  const { projectId, organizationId } = await authorize(c);
  const [result, days] = await Promise.all([
    searchProjectLogs(projectId, searchOptions(c, 1000)),
    retentionDays(organizationId),
  ]);

  return c.json({
    data: {
      retentionDays: days,
      lines: result.lines.map((line) => ({
        content: line.content,
        timestamp: line.timestamp.toISOString(),
        logType: line.logType,
        deploymentId: line.deploymentId,
        containerName: line.containerName,
      })),
      scannedChunks: result.scannedChunks,
    },
  });
});

// The containers that have logs — the filter list of the explorer
projectLogsRouter.get('/:projectId/logs/containers', async (c) => {
  const { projectId } = await authorize(c);
  return c.json({ data: { containers: await projectLogContainers(projectId) } });
});

// The same search as a plain text file, for keeping or grepping offline
projectLogsRouter.get('/:projectId/logs/export', async (c) => {
  const { projectId, project } = await authorize(c);
  const result = await searchProjectLogs(projectId, searchOptions(c, 50_000));

  // Oldest first: a log file read top to bottom
  const body = result.lines
    .slice()
    .reverse()
    .map((line) => `${line.timestamp.toISOString()} ${line.containerName ?? project.slug} ${line.logType === 'stderr' ? 'E' : 'I'} ${line.content}`)
    .join('\n');
  const name = `${project.slug}-logs-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}.log`;

  c.header('Content-Type', 'text/plain; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="${name}"`);
  return c.body(body ? `${body}\n` : '');
});

// What autoscaling decided, and whether it acted — the record someone reads for a few days
// before trusting the thresholds with their own traffic.
projectLogsRouter.get('/:projectId/scale-events', async (c) => {
  const { projectId } = await authorize(c);
  const { db } = await import('../db');
  const { projectScaleEvents } = await import('../db/schema/scale-events');
  const { desc, eq } = await import('drizzle-orm');

  const rows = await db
    .select()
    .from(projectScaleEvents)
    .where(eq(projectScaleEvents.projectId, projectId))
    .orderBy(desc(projectScaleEvents.createdAt))
    .limit(50);

  return c.json({
    data: rows.map((row) => ({
      id: row.id,
      from: row.fromCount,
      to: row.toCount,
      averageCpu: row.averageCpu,
      reason: row.reason,
      applied: row.applied,
      createdAt: row.createdAt.toISOString(),
    })),
  });
});

export { projectLogsRouter as projectLogsRoutes };
