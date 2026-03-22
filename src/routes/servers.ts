import { Hono } from 'hono';
import { serverService } from '../services/server.service';
import { authMiddleware } from '../middleware/auth';
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

// All routes require authentication
serverRouter.use('*', authMiddleware);

// ============ Provider Routes ============
// IMPORTANT: These must be defined BEFORE :serverId routes to avoid matching conflicts

// Get available regions for a provider
serverRouter.get('/providers/:provider/regions', async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;

  const regions = await serverService.getRegions(provider, locale);

  return c.json({ data: regions });
});

// Get available images for a provider
serverRouter.get('/providers/:provider/images', async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;

  const images = await serverService.getImages(provider, locale);

  return c.json({ data: images });
});

// Get available sizes for a provider
serverRouter.get('/providers/:provider/sizes', async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;

  const sizes = await serverService.getSizes(provider, locale);

  return c.json({ data: sizes });
});

// Get available server types for a provider (raw types from provider)
serverRouter.get('/providers/:provider/server-types', async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;
  const location = c.req.query('location');

  const serverTypes = await serverService.getServerTypes(provider, location, locale);

  return c.json({ data: serverTypes });
});

// ============ Server Routes ============

// List all servers
serverRouter.get('/', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');

  const servers = await serverService.listServers(organizationId, userId, locale);

  return c.json({ data: servers });
});

// Create a new server
serverRouter.post('/', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const body = await c.req.json();

  const server = await serverService.createServer(organizationId, userId, body, locale);

  return c.json({ data: server }, 201);
});

// Get a single server
serverRouter.get('/:serverId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.getServer(serverId, organizationId, userId, locale);

  return c.json({ data: server });
});

// Delete a server
serverRouter.delete('/:serverId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  await serverService.deleteServer(serverId, organizationId, userId, locale);

  return c.json({ message: t(locale, 'servers', 'deleted') });
});

// Power actions
serverRouter.post('/:serverId/start', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.powerAction(serverId, organizationId, userId, 'start', locale);

  return c.json({ data: server, message: t(locale, 'servers', 'started') });
});

serverRouter.post('/:serverId/stop', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.powerAction(serverId, organizationId, userId, 'stop', locale);

  return c.json({ data: server, message: t(locale, 'servers', 'stopped') });
});

serverRouter.post('/:serverId/reboot', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.powerAction(serverId, organizationId, userId, 'reboot', locale);

  return c.json({ data: server, message: t(locale, 'servers', 'rebooted') });
});

// Sync server status from provider
serverRouter.post('/:serverId/sync', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.syncServer(serverId, organizationId, userId, locale);

  return c.json({ data: server });
});

// ============ SSH Key Download ============

// Get SSH connection info (IP, username, public key)
serverRouter.get('/:serverId/ssh-info', async (c) => {
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
serverRouter.get('/:serverId/ssh-key', async (c) => {
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
serverRouter.post('/:serverId/terminal', async (c) => {
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
