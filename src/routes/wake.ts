import { Hono, type Context } from 'hono';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { deployments } from '../db/schema/deployments';
import { requestWake } from '../workers/app-sleep.worker';
import { authMiddleware } from '../middleware/auth';
import { organizationRepository } from '../repositories/organization.repository';
import { projectRepository } from '../repositories/project.repository';
import { HTTPException } from 'hono/http-exception';
import { logger } from '../lib/logger';
import type { AppEnv } from '../types';

function wakePage(options: { title: string; message: string; refresh?: boolean }): string {
  const { title, message, refresh } = options;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? '<meta http-equiv="refresh" content="3">' : ''}
<title>${title}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0a0a0f;color:#e5e7eb;font-family:ui-sans-serif,system-ui,sans-serif}
  .card{text-align:center;padding:2rem}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  p{color:#9ca3af;font-size:.9rem;margin:0}
  .spin{width:28px;height:28px;margin:0 auto 1rem;border:3px solid #27272a;border-top-color:#6366f1;border-radius:50%;animation:s 1s linear infinite}
  @keyframes s{to{transform:rotate(360deg)}}
  .footer{margin-top:1.5rem;font-size:.75rem;color:#52525b}
</style>
</head>
<body>
<div class="card">
${refresh ? '<div class="spin"></div>' : ''}
<h1>${title}</h1>
<p>${message}</p>
<div class="footer">Powered by Pushify</div>
</div>
</body>
</html>`;
}

/**
 * A first deploy whose build failed has nothing to serve: say so instead of "not responding",
 * which reads like a crash. Only when no deployment of the project ever ran — if one did, the
 * outage is a runtime problem (the old container died) and the generic page is the honest one.
 */
export async function neverServedBecauseBuildFailed(projectId: string): Promise<boolean> {
  try {
    const [latest] = await db
      .select({ status: deployments.status })
      .from(deployments)
      .where(eq(deployments.projectId, projectId))
      .orderBy(desc(deployments.createdAt))
      .limit(1);
    if (latest?.status !== 'failed') return false;
    const [served] = await db
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.projectId, projectId), inArray(deployments.status, ['running', 'stopped'])))
      .limit(1);
    return !served;
  } catch {
    return false;
  }
}

// ── Public wake endpoint ─────────────────────────────────────────────────────
// nginx routes a 502 (container down) here via the @pushify_wake fallback. If the app
// is sleeping we start it and serve an auto-refreshing "waking up" page; a genuine crash
// gets a branded unavailable page instead of a raw nginx 502.
const wakeRouter = new Hono<AppEnv>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WakeProject = typeof projects.$inferSelect;

async function wakeResponse(c: Context<AppEnv>, project: WakeProject | undefined): Promise<Response> {
  // Neutral on purpose: visitors learn the app is suspended, not why.
  if (project?.suspendedAt) {
    return c.html(
      wakePage({
        title: 'This app is suspended',
        message: 'This application has been suspended by Pushify and is not available.',
      }),
      503
    );
  }

  if (!project || !project.sleepEnabled || project.sleepState === 'awake') {
    if (project && (await neverServedBecauseBuildFailed(project.id))) {
      return c.html(
        wakePage({
          title: 'Deployment failed',
          message:
            'This application has not been deployed successfully yet — its latest build failed. The owner can see why in the deployment logs.',
        }),
        503
      );
    }
    return c.html(
      wakePage({
        title: 'Application unavailable',
        message: 'This application is not responding right now. Please try again shortly.',
      }),
      502
    );
  }

  // Fire the wake without holding the visitor's request; the refresh loop picks it up.
  if (project.sleepState === 'sleeping') {
    requestWake(project.id).catch(() => {});
  }

  c.header('Retry-After', '3');
  return c.html(
    wakePage({
      title: 'Waking up…',
      message: 'This app was asleep to save resources. It will be ready in a few seconds.',
      refresh: true,
    }),
    503
  );
}

// Vhosts name their project by id: a slug is only unique within an organization.
wakeRouter.all('/p/:projectId', async (c) => {
  const projectId = c.req.param('projectId');
  const project = UUID_RE.test(projectId)
    ? await db.query.projects.findFirst({
        where: and(eq(projects.id, projectId), ne(projects.status, 'deleted')),
      })
    : undefined;
  return wakeResponse(c, project);
});

// Vhosts written before the id route (and staging / PR preview vhosts, which carry no id) still
// send a slug. Two organizations can share one, so only an unambiguous match is acted on —
// otherwise a visitor could wake, or get the suspended page of, another organization's app.
wakeRouter.all('/:slug', async (c) => {
  const slug = c.req.param('slug');

  const matches = await db.query.projects.findMany({
    where: and(eq(projects.slug, slug), ne(projects.status, 'deleted')),
    limit: 2,
  });
  if (matches.length > 1) {
    logger.warn({ slug }, 'Wake by slug matches several projects; serving the unavailable page');
    return wakeResponse(c, undefined);
  }

  return wakeResponse(c, matches[0]);
});

export { wakeRouter as wakeRoutes };

// ── Authenticated manual wake (dashboard button) ─────────────────────────────
const projectWakeRouter = new Hono<AppEnv>();

projectWakeRouter.use('*', authMiddleware);

projectWakeRouter.post('/:projectId/wake', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const projectId = c.req.param('projectId');

  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: 'No access' });
  }
  const project = await projectRepository.findById(projectId);
  if (!project || project.organizationId !== organizationId) {
    throw new HTTPException(404, { message: 'Project not found' });
  }

  if (project.suspendedAt) {
    throw new HTTPException(403, { message: 'This project is suspended' });
  }
  const result = await requestWake(projectId);
  return c.json({ data: { result } });
});

export { projectWakeRouter as projectWakeRoutes };
