import { Hono } from 'hono';
import { scheduledTaskService } from '../services/scheduled-task.service';
import { executeScheduledTask } from '../workers/scheduled-task.worker';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

const scheduledTaskRouter = new Hono<AppEnv>();

scheduledTaskRouter.use('*', authMiddleware);

// List a project's scheduled tasks
scheduledTaskRouter.get('/:projectId/scheduled-tasks', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const tasks = await scheduledTaskService.listTasks(projectId, organizationId, userId, locale);
  return c.json({ data: tasks });
});

// Create a scheduled task
scheduledTaskRouter.post('/:projectId/scheduled-tasks', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const body = await c.req.json();

  const task = await scheduledTaskService.createTask(
    projectId,
    organizationId,
    userId,
    body,
    locale
  );
  return c.json({ data: task }, 201);
});

// Update a scheduled task (fields, schedule, enable/disable)
scheduledTaskRouter.patch('/:projectId/scheduled-tasks/:taskId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const taskId = c.req.param('taskId');
  const body = await c.req.json();

  const task = await scheduledTaskService.updateTask(
    projectId,
    taskId,
    organizationId,
    userId,
    body,
    locale
  );
  return c.json({ data: task });
});

// Delete a scheduled task
scheduledTaskRouter.delete('/:projectId/scheduled-tasks/:taskId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const taskId = c.req.param('taskId');

  await scheduledTaskService.deleteTask(projectId, taskId, organizationId, userId, locale);
  return c.json({ data: { deleted: true } });
});

// Run a task immediately (also records a run with trigger=manual)
scheduledTaskRouter.post('/:projectId/scheduled-tasks/:taskId/run', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const taskId = c.req.param('taskId');

  // Access check + existence via the service, then execute synchronously so the
  // response carries the outcome (manual runs are interactive).
  await scheduledTaskService.listTasks(projectId, organizationId, userId, locale);
  const task = await scheduledTaskService.getTask(projectId, taskId);
  const result = await executeScheduledTask(task, 'manual');
  return c.json({ data: result });
});

// Run history for a task
scheduledTaskRouter.get('/:projectId/scheduled-tasks/:taskId/runs', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const taskId = c.req.param('taskId');
  const limit = parseInt(c.req.query('limit') || '20', 10) || 20;

  const runs = await scheduledTaskService.listRuns(
    projectId,
    taskId,
    organizationId,
    userId,
    locale,
    limit
  );
  return c.json({ data: runs });
});

export { scheduledTaskRouter as scheduledTaskRoutes };
