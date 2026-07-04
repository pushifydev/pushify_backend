import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { requestWake } from '../workers/app-sleep.worker';
import { authMiddleware } from '../middleware/auth';
import { organizationRepository } from '../repositories/organization.repository';
import { projectRepository } from '../repositories/project.repository';
import { HTTPException } from 'hono/http-exception';
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

// ── Public wake endpoint ─────────────────────────────────────────────────────
// nginx routes a 502 (container down) here via the @pushify_wake fallback. If the app
// is sleeping we start it and serve an auto-refreshing "waking up" page; a genuine crash
// gets a branded unavailable page instead of a raw nginx 502.
const wakeRouter = new Hono<AppEnv>();

wakeRouter.all('/:slug', async (c) => {
  const slug = c.req.param('slug');

  const project = await db.query.projects.findFirst({ where: eq(projects.slug, slug) });

  if (!project || !project.sleepEnabled || project.sleepState === 'awake') {
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

  const result = await requestWake(projectId);
  return c.json({ data: { result } });
});

export { projectWakeRouter as projectWakeRoutes };
