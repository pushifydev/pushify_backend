import { Hono } from 'hono';
import { notificationService } from '../services/notification.service';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

const notificationRouter = new Hono<AppEnv>();

// All routes require authentication
notificationRouter.use('*', authMiddleware);

// Get all notification channels for a project
notificationRouter.get('/:projectId/notifications', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const channels = await notificationService.getChannels(
    projectId,
    organizationId,
    userId,
    locale
  );

  return c.json({ data: channels });
});

// Create a notification channel
notificationRouter.post('/:projectId/notifications', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const body = await c.req.json();

  const channel = await notificationService.createChannel(
    projectId,
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({
    data: channel,
    message: t(locale, 'notifications', 'created'),
  }, 201);
});

// Update a notification channel
notificationRouter.patch('/:projectId/notifications/:channelId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const channelId = c.req.param('channelId');
  const body = await c.req.json();

  const channel = await notificationService.updateChannel(
    channelId,
    projectId,
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({
    data: channel,
    message: t(locale, 'notifications', 'updated'),
  });
});

// Delete a notification channel
notificationRouter.delete('/:projectId/notifications/:channelId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const channelId = c.req.param('channelId');

  await notificationService.deleteChannel(
    channelId,
    projectId,
    organizationId,
    userId,
    locale
  );

  return c.json({ message: t(locale, 'notifications', 'deleted') });
});

// Test a notification channel
notificationRouter.post('/:projectId/notifications/:channelId/test', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const channelId = c.req.param('channelId');

  await notificationService.testChannel(
    channelId,
    projectId,
    organizationId,
    userId,
    locale
  );

  return c.json({ message: t(locale, 'notifications', 'testSent') });
});

// Get notification logs for a channel
notificationRouter.get('/:projectId/notifications/:channelId/logs', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const channelId = c.req.param('channelId');

  const logs = await notificationService.getChannelLogs(
    channelId,
    projectId,
    organizationId,
    userId,
    locale
  );

  return c.json({ data: logs });
});

export { notificationRouter as notificationRoutes };
