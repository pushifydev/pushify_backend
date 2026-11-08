import { randomUUID } from 'crypto';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';
import { requireOrgMember } from '../lib/org-access';
import { auditSource, diffChanges } from '../lib/audit';
import { logger } from '../lib/logger';
import { addServerPatchJob, isQueueAvailable } from '../lib/queue';
import { acquireServerPatchLock, releaseServerPatchLock } from '../lib/server-patch-lock';
import {
  AUTO_PATCH_SCHEDULES,
  AUTO_PATCH_WINDOW_MINUTES,
  removeServerAutoPatchSchedule,
  syncServerAutoPatchSchedule,
  toAutoPatchSettings,
  type AutoPatchSettings,
} from '../lib/server-auto-patch';
import { activityService } from '../services/activity.service';
import { metricsRepository } from '../repositories/metrics.repository';
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
import { UNINSTALL_SCRIPT_URL } from '../lib/server-key-removal';
import { buildSshConnectCommand } from '../lib/server-address';
import type { AppEnv } from '../types';
import type { ProviderType } from '../providers';
import type { ServerSize } from '../providers/cloud-provider.interface';

const serverRouter = new OpenAPIHono<AppEnv>();

// JWT or API key (pk_live_...)
serverRouter.use('*', combinedAuthMiddleware);

// ============ Provider Routes ============
// IMPORTANT: These must be defined BEFORE :serverId routes to avoid matching conflicts

// Get available regions for a provider
serverRouter.get('/providers/:provider/regions', requireScope('servers:read'), async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;
  const organizationId = c.get('organizationId');

  const regions = await serverService.getRegions(provider, locale, organizationId ?? undefined);

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

// Get available server types for a provider (raw types from provider).
// The provider's own list prices are stripped: customers see Pushify prices (the /sizes
// endpoint), never what the provider charges us.
serverRouter.get('/providers/:provider/server-types', requireScope('servers:read'), async (c) => {
  const locale = c.get('locale');
  const provider = c.req.param('provider') as ProviderType;
  const location = c.req.query('location');

  const serverTypes = await serverService.getServerTypes(provider, location, locale);

  return c.json({ data: serverTypes.map(({ priceMonthly: _m, priceHourly: _h, ...rest }) => rest) });
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

// Who's using this server: latest per-project container snapshot (CPU / memory share)
serverRouter.get('/:serverId/containers', requireScope('servers:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  await serverService.getServer(serverId, organizationId, userId, locale);

  const rows = await metricsRepository.findLatestByServer(serverId);
  const totalCpu = rows.reduce((sum, r) => sum + Number(r.cpuPercent), 0);
  const totalMem = rows.reduce((sum, r) => sum + Number(r.memoryUsageBytes), 0);

  return c.json({
    data: {
      recordedAt: rows[0]?.recordedAt ?? null,
      totals: { cpuPercent: Math.round(totalCpu * 10) / 10, memoryUsageMb: Math.round(totalMem / 1048576) },
      containers: rows.map((r) => ({
        projectId: r.projectId,
        projectName: r.projectName,
        projectSlug: r.projectSlug,
        containerName: r.containerName,
        status: r.containerStatus,
        cpuPercent: Math.round(Number(r.cpuPercent) * 10) / 10,
        memoryUsageMb: Math.round(Number(r.memoryUsageBytes) / 1048576),
        memoryLimitMb: Math.round(Number(r.memoryLimitBytes) / 1048576),
        memoryPercent: Math.round(Number(r.memoryPercent) * 10) / 10,
        // Share of everything Pushify runs on this box — the "who eats what" number.
        cpuShare: totalCpu > 0 ? Math.round((Number(r.cpuPercent) / totalCpu) * 100) : 0,
        memoryShare: totalMem > 0 ? Math.round((Number(r.memoryUsageBytes) / totalMem) * 100) : 0,
      })),
    },
  });
});

// Deployment host health: disk usage + orphan Pushify containers
serverRouter.get('/:serverId/health', requireScope('servers:read'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  const server = await serverService.getServer(serverId, organizationId, userId, locale);

  if (server.setupStatus !== 'completed') {
    return c.json(
      { error: { code: 'SERVER_NOT_READY', message: t(locale, 'servers', 'notReadyForDeploy') } },
      400
    );
  }

  const serverRow = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });

  if (!serverRow?.sshPrivateKey || !serverRow.ipv4) {
    return c.json(
      { error: { code: 'SSH_UNAVAILABLE', message: t(locale, 'servers', 'notReadyForDeploy') } },
      400
    );
  }

  const { scanServerHealth } = await import('../lib/server-health-scan');
  const report = await scanServerHealth(serverRow, organizationId);

  return c.json({ data: report });
});

// Apply pending OS security updates (owner/admin). Queued: the outcome (output, updates left,
// reboot required) lands on the server timeline and the audit log. Never reboots.
serverRouter.post('/:serverId/patches/apply', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');

  await requireOrgMember(organizationId, userId, 'admin', locale);

  const server = await db.query.servers.findFirst({
    where: and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)),
  });

  if (!server) {
    return c.json({ error: { code: 'NOT_FOUND', message: t(locale, 'servers', 'notFound') } }, 404);
  }

  if (server.setupStatus !== 'completed' || server.status !== 'running') {
    return c.json(
      { error: { code: 'SERVER_NOT_READY', message: 'Server must be running with setup completed' } },
      400
    );
  }

  if (!server.sshPrivateKey || !server.ipv4) {
    return c.json({ error: { code: 'SSH_UNAVAILABLE', message: 'Server is not reachable via SSH' } }, 400);
  }

  if (!isQueueAvailable()) {
    return c.json(
      { error: { code: 'QUEUE_UNAVAILABLE', message: 'Background jobs are not available (Redis is not configured)' } },
      503
    );
  }

  const lockToken = randomUUID();
  if (!(await acquireServerPatchLock(serverId, lockToken))) {
    return c.json(
      { error: { code: 'PATCH_RUN_IN_PROGRESS', message: 'Security updates are already being applied to this server' } },
      409
    );
  }

  let job: Awaited<ReturnType<typeof addServerPatchJob>>;
  try {
    job = await addServerPatchJob({ serverId, organizationId, requestedBy: userId, lockToken });
  } catch (err) {
    await releaseServerPatchLock(serverId, lockToken);
    throw err;
  }
  if (!job) {
    await releaseServerPatchLock(serverId, lockToken);
    return c.json(
      { error: { code: 'QUEUE_UNAVAILABLE', message: 'Background jobs are not available (Redis is not configured)' } },
      503
    );
  }

  await activityService.log({
    organizationId,
    userId,
    action: 'server.patches_requested',
    description: `Requested security updates on server "${server.name}"`,
    metadata: { serverId, serverName: server.name, jobId: job.id },
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
    source: auditSource(c),
  });

  return c.json(
    {
      data: { jobId: job.id, serverId, status: 'queued' },
      message: 'Applying security updates. The result will appear on the server timeline.',
    },
    202
  );
});

// ============ Automatic security updates (scheduled) ============

const ServerAutoPatchLastRunSchema = z
  .object({
    at: z.string().openapi({ description: 'When the run ended (ISO)' }),
    status: z.enum(['applied', 'failed', 'skipped']).openapi({
      description: 'skipped: a deploy was going on for the whole maintenance window, nothing was installed',
    }),
    packagesApplied: z.number().int().nullable().openapi({
      description: 'Packages upgraded (apt). Null on dnf, which picks them itself, and when nothing ran',
    }),
    rebootRequired: z.union([z.boolean(), z.literal('unknown')]).nullable().openapi({
      description: 'Whether the server now needs a reboot (Pushify never reboots it). Null when nothing ran',
    }),
    summary: z.string().nullable(),
    error: z.string().nullable(),
    code: z.string().nullable().openapi({ example: 'DEPLOY_IN_PROGRESS' }),
  })
  .openapi('ServerAutoPatchLastRun');

const ServerAutoPatchSchema = z
  .object({
    autoPatch: z.enum(AUTO_PATCH_SCHEDULES),
    autoPatchHour: z.number().int().openapi({ description: 'Hour (UTC) the maintenance window starts' }),
    autoPatchWeekday: z.number().int().openapi({ description: 'Weekly: day of the week (UTC), 0 = Sunday … 6 = Saturday' }),
    windowMinutes: z.number().int().openapi({ description: 'A scheduled run only starts inside the window' }),
    lastRun: ServerAutoPatchLastRunSchema.nullable().openapi({
      description: 'Last scheduled run, also returned as `lastAutoPatch` by GET /servers/{serverId}/health',
    }),
  })
  .openapi('ServerAutoPatch');

const UpdateServerAutoPatchSchema = z
  .object({
    autoPatch: z.enum(AUTO_PATCH_SCHEDULES).openapi({ example: 'weekly' }),
    autoPatchHour: z.number().int().min(0).max(23).optional().openapi({
      example: 3,
      description: 'Hour (UTC) the 60-minute maintenance window starts. Left out keeps the stored one (default 3)',
    }),
    autoPatchWeekday: z.number().int().min(0).max(6).optional().openapi({
      example: 0,
      description: 'Weekly only: day of the week (UTC), 0 = Sunday … 6 = Saturday. Left out keeps the stored one (default 0)',
    }),
  })
  .openapi('UpdateServerAutoPatch');

const updateAutoPatchRoute = createRoute({
  method: 'put',
  path: '/{serverId}/auto-patch',
  tags: ['Servers'],
  summary: 'Schedule automatic security updates',
  description:
    'Owner/admin only, off by default. Daily or weekly, the pending OS security updates are applied as by ' +
    'POST /servers/{serverId}/patches/apply (Docker/containerd excluded, never reboots), starting inside a ' +
    '60-minute maintenance window in UTC. While a deploy is going on on the server the run waits; if that lasts ' +
    'the whole window it is skipped. Every run goes to the audit log and the server timeline.',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({ serverId: z.string().uuid() }),
    body: { content: { 'application/json': { schema: UpdateServerAutoPatchSchema } } },
  },
  responses: {
    200: {
      description: 'Setting stored and schedule updated',
      content: { 'application/json': { schema: z.object({ data: ServerAutoPatchSchema, message: z.string() }) } },
    },
    503: { description: 'Turning it on needs background jobs (Redis)' },
  },
});

serverRouter.put('/:serverId/auto-patch', requireScope('servers:write'));
serverRouter.openapi(updateAutoPatchRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { serverId } = c.req.valid('param');
  const input = c.req.valid('json');

  await requireOrgMember(organizationId, userId, 'admin', locale);

  const server = await db.query.servers.findFirst({
    where: and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)),
  });
  if (!server) {
    throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
  }

  const previous = toAutoPatchSettings(server);
  const next: AutoPatchSettings = {
    autoPatch: input.autoPatch,
    autoPatchHour: input.autoPatchHour ?? previous.autoPatchHour,
    autoPatchWeekday: input.autoPatchWeekday ?? previous.autoPatchWeekday,
  };

  // Schedule first, so a setting nothing would run is never stored
  if (next.autoPatch !== 'off' && !(await syncServerAutoPatchSchedule({ id: serverId, organizationId, ...next }))) {
    throw new HTTPException(503, {
      message: 'Background jobs are not available (Redis is not configured)',
      cause: { code: 'QUEUE_UNAVAILABLE' },
    });
  }

  const [updated] = await db
    .update(servers)
    .set({ ...next, updatedAt: new Date() })
    .where(eq(servers.id, serverId))
    .returning();

  if (next.autoPatch === 'off') {
    // Best effort: a scheduled run that still fires finds the setting off and removes the schedule
    await removeServerAutoPatchSchedule(serverId).catch((err) => {
      logger.warn({ err, serverId }, 'Could not remove the automatic security update schedule');
    });
  }

  const when =
    next.autoPatch === 'off'
      ? 'off'
      : `${next.autoPatch}${next.autoPatch === 'weekly' ? ` (weekday ${next.autoPatchWeekday})` : ''} at ${String(next.autoPatchHour).padStart(2, '0')}:00 UTC`;

  await activityService.log({
    organizationId,
    userId,
    action: 'settings.updated',
    description: `Automatic security updates on server "${server.name}": ${when}`,
    metadata: { setting: 'server_auto_patch', serverId, serverName: server.name },
    changes: diffChanges({ ...previous }, { ...next }),
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
    source: auditSource(c),
  });

  return c.json(
    {
      data: { ...next, windowMinutes: AUTO_PATCH_WINDOW_MINUTES, lastRun: updated?.lastAutoPatch ?? null },
      message: next.autoPatch === 'off' ? 'Automatic security updates turned off' : `Automatic security updates scheduled: ${when}`,
    },
    200
  );
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

  const { keyRemoval } = await serverService.deleteServer(serverId, organizationId, userId, locale);

  // keyRemoval is null for servers Pushify created (the machine itself is gone). For a connected
  // server whose key could not be removed, the client shows manualCommand.
  return c.json({
    message: t(locale, 'servers', 'deleted'),
    data: keyRemoval
      ? {
          keyRemoved: keyRemoval.keyRemoved,
          manualCommand: keyRemoval.manualCommand ?? null,
          uninstallScriptUrl: UNINSTALL_SCRIPT_URL,
        }
      : null,
  });
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

// Retry BYOS setup after failed SSH connection / install
serverRouter.post('/:serverId/retry-setup', requireScope('servers:write'), async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const serverId = c.req.param('serverId');
  const body = await c.req.json<{ rootPassword?: string; sshPrivateKey?: string }>().catch(() => ({}));

  const server = await serverService.retryByosSetup(serverId, organizationId, userId, body, locale);

  return c.json({ data: server, message: 'Server setup retry started' });
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
    body.size as ServerSize,
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
  await requireOrgMember(organizationId, c.get('userId')!, 'viewer', c.get('locale'));

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
      connectCommand: buildSshConnectCommand({ keyFile: `pushify_${server.name}.pem`, host: server.ipv4 ?? '' }),
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
