import { Hono } from 'hono';
import { databaseService } from '../services/database.service';
import { databaseStudioRoutes } from './database-studio';
import { nosqlStudioRoutes } from './nosql-studio';
import { databaseBackupService } from '../services/database-backup.service';
import { combinedAuthMiddleware } from '../middleware/auth';
import { requireScope } from '../middleware/apikey-auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

const databasesRouter = new Hono<AppEnv>();

// JWT or API key (pk_live_...)
databasesRouter.use('*', combinedAuthMiddleware);

// Get all databases for organization
databasesRouter.get('/', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const databases = await databaseService.list(organizationId, userId, locale);

  return c.json({ data: databases });
});

// Get available database types
databasesRouter.get('/types', requireScope('databases:read'), async (c) => {
  const types = databaseService.getAvailableTypes();
  return c.json({ data: types });
});

// Get single database
databasesRouter.get('/:id', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');

  const database = await databaseService.get(databaseId, organizationId, userId, locale);

  return c.json({ data: database });
});

// Get database connection details (with actual credentials)
databasesRouter.get('/:id/credentials', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');

  const credentials = await databaseService.getConnectionDetails(
    databaseId,
    organizationId,
    userId,
    locale
  );

  return c.json({ data: credentials });
});

// Create database
databasesRouter.post('/', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const database = await databaseService.create(organizationId, userId, body, locale);

  return c.json({
    data: database,
    message: t(locale, 'databases', 'created'),
  }, 201);
});

// Update database
databasesRouter.patch('/:id', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');
  const body = await c.req.json();

  const database = await databaseService.update(
    databaseId,
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({
    data: database,
    message: t(locale, 'databases', 'updated'),
  });
});

// Delete database
databasesRouter.delete('/:id', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');

  await databaseService.delete(databaseId, organizationId, userId, locale);

  return c.json({ message: t(locale, 'databases', 'deleted') });
});

// Connect database to project
databasesRouter.post('/:id/connect', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');
  const body = await c.req.json();

  const connection = await databaseService.connectToProject(
    databaseId,
    organizationId,
    userId,
    body,
    locale
  );

  return c.json({
    data: connection,
    message: t(locale, 'databases', 'connected'),
  }, 201);
});

// Disconnect database from project
databasesRouter.delete('/connections/:connectionId', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const connectionId = c.req.param('connectionId');

  await databaseService.disconnectFromProject(connectionId, organizationId, userId, locale);

  return c.json({ message: t(locale, 'databases', 'disconnected') });
});

// Toggle external access
databasesRouter.post('/:id/external-access', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');
  const { enabled } = await c.req.json();

  const database = await databaseService.toggleExternalAccess(
    databaseId,
    organizationId,
    userId,
    enabled,
    locale
  );

  return c.json({
    data: database,
    message: t(locale, 'databases', enabled ? 'externalAccessEnabled' : 'externalAccessDisabled'),
  });
});

// Start database
databasesRouter.post('/:id/start', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');

  await databaseService.start(databaseId, organizationId, userId, locale);

  return c.json({ message: t(locale, 'databases', 'started') });
});

// Stop database
databasesRouter.post('/:id/stop', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');

  await databaseService.stop(databaseId, organizationId, userId, locale);

  return c.json({ message: t(locale, 'databases', 'stopped') });
});

// Restart database
databasesRouter.post('/:id/restart', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');

  await databaseService.restart(databaseId, organizationId, userId, locale);

  return c.json({ message: t(locale, 'databases', 'restarted') });
});

// Reset database password
databasesRouter.post('/:id/reset-password', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');

  const result = await databaseService.resetPassword(databaseId, organizationId, userId, locale);

  return c.json({
    data: result,
    message: t(locale, 'databases', 'passwordReset'),
  });
});

// ============ Backup Routes ============

// List backups for a database
databasesRouter.get('/:id/backups', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');

  const backups = await databaseBackupService.listBackups(databaseId, organizationId, userId, locale);

  return c.json({ data: backups });
});

// Create manual backup
databasesRouter.post('/:id/backups', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');

  const backup = await databaseBackupService.createBackup(databaseId, organizationId, userId, locale);

  return c.json({
    data: backup,
    message: t(locale, 'databases', 'backupCreated'),
  }, 201);
});

// Get single backup
databasesRouter.get('/:id/backups/:backupId', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');
  const backupId = c.req.param('backupId');

  const backup = await databaseBackupService.getBackup(databaseId, backupId, organizationId, userId, locale);

  return c.json({ data: backup });
});

// Restore from backup
databasesRouter.post('/:id/backups/:backupId/restore', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');
  const backupId = c.req.param('backupId');

  const result = await databaseBackupService.restoreBackup(databaseId, backupId, organizationId, userId, locale);

  return c.json(result);
});

// Delete backup
databasesRouter.delete('/:id/backups/:backupId', requireScope('databases:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');
  const backupId = c.req.param('backupId');

  await databaseBackupService.deleteBackup(databaseId, backupId, organizationId, userId, locale);

  return c.json({ message: t(locale, 'databases', 'backupDeleted') });
});

// Download backup file
databasesRouter.get('/:id/backups/:backupId/download', requireScope('databases:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const databaseId = c.req.param('id');
  const backupId = c.req.param('backupId');

  const { buffer, fileName } = await databaseBackupService.downloadBackup(
    databaseId,
    backupId,
    organizationId,
    userId,
    locale
  );

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Content-Length': buffer.length.toString(),
    },
  });
});

// Data browser (tables, rows, SQL console) for PostgreSQL/MySQL databases
databasesRouter.route('/', databaseStudioRoutes);

// Data browser for MongoDB and Redis
databasesRouter.route('/', nosqlStudioRoutes);

export { databasesRouter as databaseRoutes };
