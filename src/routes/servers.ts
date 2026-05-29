import { Hono } from 'hono';
import { serverService } from '../services/server.service';
import { combinedAuthMiddleware } from '../middleware/auth';
import { requireScope, rejectApiKeyAuth } from '../middleware/apikey-auth';
import { t } from '../i18n';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { organizationMembers } from '../db/schema/organizations';
import { eq, and } from 'drizzle-orm';
import { decrypt } from '../lib/encryption';
import { SSHClient } from '../utils/ssh';
import type { AppEnv } from '../types';
import type { ProviderType } from '../providers';

const serverRouter = new Hono<AppEnv>();

// JWT or API key (pk_live_...)
serverRouter.use('*', combinedAuthMiddleware);

// ============ Provider Routes ============
// IMPORTANT: These must be defined BEFORE :serverId routes to avoid matching conflicts

// Get available regions for a provider
serverRouter.get('/providers/:provider/regions', requireScope('servers:read'), async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;

  const regions = await serverService.getRegions(provider, locale);

  return c.json({ data: regions });
});

// Get available images for a provider
serverRouter.get('/providers/:provider/images', requireScope('servers:read'), async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;

  const images = await serverService.getImages(provider, locale);

  return c.json({ data: images });
});

// Get available sizes for a provider (with plan limits + customer pricing)
serverRouter.get('/providers/:provider/sizes', requireScope('servers:read'), async (c) => {
  const locale = c.get('locale');
  const organizationId = c.get('organizationId')!;
  const provider = c.req.param('provider') as ProviderType;
  const region = c.req.query('region') || 'fsn1';

  const sizes = await serverService.getSizesForOrganization(
    organizationId,
    provider,
    region,
    locale,
  );

  return c.json({ data: sizes });
});

// Get available server types for a provider (raw types from provider)
serverRouter.get('/providers/:provider/server-types', requireScope('servers:read'), async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;
  const location = c.req.query('location');

  const serverTypes = await serverService.getServerTypes(provider, location, locale);

  return c.json({ data: serverTypes });
});

// ============ Server Routes ============

// List all servers
serverRouter.get('/', requireScope('servers:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const servers = await serverService.listServers(organizationId, userId, locale);

  return c.json({ data: servers });
});

// Create a new server
serverRouter.post('/', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const server = await serverService.createServer(organizationId, userId, body, locale);

  return c.json({ data: server }, 201);
});

// Get a single server
serverRouter.get('/:serverId', requireScope('servers:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.getServer(serverId, organizationId, userId, locale);

  return c.json({ data: server });
});

// Delete a server
serverRouter.delete('/:serverId', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  await serverService.deleteServer(serverId, organizationId, userId, locale);

  return c.json({ message: t(locale, 'servers', 'deleted') });
});

// Power actions
serverRouter.post('/:serverId/start', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.powerAction(serverId, organizationId, userId, 'start', locale);

  return c.json({ data: server, message: t(locale, 'servers', 'started') });
});

serverRouter.post('/:serverId/stop', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.powerAction(serverId, organizationId, userId, 'stop', locale);

  return c.json({ data: server, message: t(locale, 'servers', 'stopped') });
});

serverRouter.post('/:serverId/reboot', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.powerAction(serverId, organizationId, userId, 'reboot', locale);

  return c.json({ data: server, message: t(locale, 'servers', 'rebooted') });
});

// Sync server status from provider
serverRouter.post('/:serverId/sync', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.syncServer(serverId, organizationId, userId, locale);

  return c.json({ data: server });
});

// Update name / description
serverRouter.patch('/:serverId', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');
  const body = await c.req.json<{
    name?: string;
    description?: string | null;
    autoSnapshotEnabled?: boolean;
  }>();

  const server = await serverService.updateServer(serverId, organizationId, userId, body, locale);

  return c.json({ data: server, message: t(locale, 'servers', 'updated') });
});

// Resize (upgrade) managed server
serverRouter.get('/:serverId/resize-options', requireScope('servers:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const options = await serverService.getResizeOptions(serverId, organizationId, userId, locale);

  return c.json({ data: options });
});

serverRouter.post('/:serverId/resize', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');
  const body = await c.req.json<{ size: string }>();

  if (!body.size) {
    return c.json({ error: { code: 'INVALID_INPUT', message: 'size is required' } }, 400);
  }

  const server = await serverService.resizeServer(
    serverId,
    organizationId,
    userId,
    body.size as 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'custom',
    locale,
  );

  return c.json({ data: server, message: t(locale, 'servers', 'resized') });
});

// Snapshots (managed Hetzner)
serverRouter.get('/:serverId/snapshots', requireScope('servers:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const snapshots = await serverService.listServerSnapshots(
    serverId,
    organizationId,
    userId,
    locale,
  );

  return c.json({ data: snapshots });
});

serverRouter.post('/:serverId/snapshots', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');
  const body = await c.req.json<{ name?: string; description?: string }>();

  const snapshot = await serverService.createServerSnapshot(
    serverId,
    organizationId,
    userId,
    body,
    locale,
  );

  return c.json({ data: snapshot, message: t(locale, 'servers', 'snapshotCreated') }, 201);
});

serverRouter.delete('/:serverId/snapshots/:snapshotId', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');
  const snapshotId = c.req.param('snapshotId');

  await serverService.deleteServerSnapshot(serverId, organizationId, userId, snapshotId, locale);

  return c.json({ message: t(locale, 'servers', 'snapshotDeleted') });
});

serverRouter.post(
  '/:serverId/snapshots/:snapshotId/restore',
  requireScope('servers:write'),
  async (c) => {
    const userId = c.get('userId')!;
    const organizationId = c.get('organizationId')!;
    const locale = c.get('locale');
    const serverId = c.req.param('serverId');
    const snapshotId = c.req.param('snapshotId');

    const server = await serverService.restoreServerSnapshot(
      serverId,
      organizationId,
      userId,
      snapshotId,
      locale,
    );

    return c.json({ data: server, message: t(locale, 'servers', 'snapshotRestoreStarted') }, 200);
  },
);

// Timeline (lifecycle + deployments on this server)
serverRouter.get('/:serverId/timeline', requireScope('servers:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const timeline = await serverService.getServerTimeline(
    serverId,
    organizationId,
    userId,
    locale,
  );

  return c.json({ data: timeline });
});

// ============ SSH Key Download ============

// Get SSH connection info (IP, username, public key)
serverRouter.get('/:serverId/ssh-info', requireScope('servers:read'), async (c) => {
  const serverId = c.req.param('serverId');
  const organizationId = c.get('organizationId')!;

  const server = await db.query.servers.findFirst({
    where: and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)),
  });

  if (!server) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Server not found' } }, 404);
  }

  return c.json({
    data: {
      host: server.ipv4,
      username: 'root',
      port: 22,
      publicKey: server.sshPublicKey,
      hasPrivateKey: !!server.sshPrivateKey,
    },
  });
});

// Download SSH private key (one-time display)
serverRouter.get('/:serverId/ssh-key', rejectApiKeyAuth(), async (c) => {
  const serverId = c.req.param('serverId');
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;

  // Only owner/admin can download SSH keys
  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.organizationId, organizationId),
      eq(organizationMembers.userId, userId),
    ),
  });

  if (!member || !['owner', 'admin'].includes(member.role)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Only owners and admins can access SSH keys' } }, 403);
  }

  const server = await db.query.servers.findFirst({
    where: and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)),
  });

  if (!server || !server.sshPrivateKey) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'SSH key not found' } }, 404);
  }

  const privateKey = decrypt(server.sshPrivateKey);

  return c.json({
    data: {
      privateKey,
      host: server.ipv4,
      username: 'root',
      port: 22,
      connectCommand: `ssh -i pushify_${server.name}.pem root@${server.ipv4}`,
    },
  });
});

// ============ Web Terminal ============

// Execute command on server (REST-based terminal)
serverRouter.post('/:serverId/terminal', rejectApiKeyAuth(), async (c) => {
  const serverId = c.req.param('serverId');
  const organizationId = c.get('organizationId')!;
  const userId = c.get('userId')!;

  // Only owner/admin can use terminal
  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.organizationId, organizationId),
      eq(organizationMembers.userId, userId),
    ),
  });

  if (!member || !['owner', 'admin'].includes(member.role)) {
    return c.json({ error: { code: 'FORBIDDEN', message: 'Only owners and admins can use the terminal' } }, 403);
  }

  const server = await db.query.servers.findFirst({
    where: and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)),
  });

  if (!server || !server.sshPrivateKey || !server.ipv4) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Server not found or not accessible' } }, 404);
  }

  if (server.status !== 'running') {
    return c.json({ error: { code: 'SERVER_NOT_RUNNING', message: 'Server is not running' } }, 400);
  }

  const { command } = await c.req.json<{ command: string }>();

  if (!command || typeof command !== 'string') {
    return c.json({ error: { code: 'INVALID_COMMAND', message: 'Command is required' } }, 400);
  }

  // Block dangerous commands
  const blockedPatterns = [/rm\s+-rf\s+\/(?!\w)/, /mkfs/, /dd\s+if=/, /:(){ :|:& };:/];
  if (blockedPatterns.some((p) => p.test(command))) {
    return c.json({ error: { code: 'BLOCKED_COMMAND', message: 'This command is not allowed for safety reasons' } }, 403);
  }

  let ssh: SSHClient | null = null;
  try {
    ssh = new SSHClient();
    await ssh.connect({
      host: server.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    const result = await ssh.exec(command);

    return c.json({
      data: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
      },
    });
  } catch (err) {
    return c.json({
      error: {
        code: 'SSH_ERROR',
        message: err instanceof Error ? err.message : 'Failed to execute command',
      },
    }, 500);
  } finally {
    ssh?.disconnect();
  }
});

export { serverRouter as serverRoutes };
