import { Hono } from 'hono';
import { projectWorkerService } from '../services/project-worker.service';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

const projectWorkerRouter = new Hono<AppEnv>();

projectWorkerRouter.use('*', authMiddleware);

// List a project's worker processes
projectWorkerRouter.get('/:projectId/workers', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const workers = await projectWorkerService.listWorkers(projectId, organizationId, userId, locale);
  return c.json({ data: workers });
});

// Live container states for the project's workers
projectWorkerRouter.get('/:projectId/workers/status', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const statuses = await projectWorkerService.getWorkerStatuses(
    projectId,
    organizationId,
    userId,
    locale
  );
  return c.json({ data: statuses });
});

// Create a worker (starts on the next deploy)
projectWorkerRouter.post('/:projectId/workers', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const body = await c.req.json();

  const worker = await projectWorkerService.createWorker(
    projectId,
    organizationId,
    userId,
    body,
    locale
  );
  return c.json({ data: worker }, 201);
});

// Update a worker (disable stops the container now; other changes apply on next deploy)
projectWorkerRouter.patch('/:projectId/workers/:workerId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const workerId = c.req.param('workerId');
  const body = await c.req.json();

  const worker = await projectWorkerService.updateWorker(
    projectId,
    workerId,
    organizationId,
    userId,
    body,
    locale
  );
  return c.json({ data: worker });
});

// Delete a worker (removes its container)
projectWorkerRouter.delete('/:projectId/workers/:workerId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const workerId = c.req.param('workerId');

  await projectWorkerService.deleteWorker(projectId, workerId, organizationId, userId, locale);
  return c.json({ message: 'ok' });
});

// Tail a worker container's logs
projectWorkerRouter.get('/:projectId/workers/:workerId/logs', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const workerId = c.req.param('workerId');
  const tail = Math.min(Math.max(parseInt(c.req.query('tail') || '100', 10) || 100, 1), 1000);

  const result = await projectWorkerService.getWorkerLogs(
    projectId,
    workerId,
    organizationId,
    userId,
    tail,
    locale
  );
  return c.json({ data: result });
});

export { projectWorkerRouter as projectWorkerRoutes };
