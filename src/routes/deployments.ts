import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { deploymentService } from '../services/deployment.service';
import { activityService } from '../services/activity.service';
import { combinedAuthMiddleware } from '../middleware/auth';
import { requireScope } from '../middleware/apikey-auth';
import { createDeploymentRateLimiter } from '../middleware/rate-limit';
import { t } from '../i18n';
import type { AppEnv } from '../types';
import { streamContainerLogs, isContainerRunning } from '../workers/docker';
import { getContainerLogs as getRemoteContainerLogs, isContainerRunning as isRemoteContainerRunning } from '../workers/remote-docker';
import { getHistoricalLogs } from '../workers/log-collector';
import { SSHClient } from '../utils/ssh';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { projects } from '../db/schema/projects';
import { eq } from 'drizzle-orm';
import { decrypt } from '../lib/encryption';

// Rate limiter for deployment operations
const deploymentRateLimiter = createDeploymentRateLimiter();

// ============ Schemas ============

const DeploymentStatusEnum = z.enum([
  'pending',
  'building',
  'deploying',
  'running',
  'failed',
  'stopped',
  'cancelled',
]);

const DeploymentTriggerEnum = z.enum(['manual', 'git_push', 'rollback', 'redeploy']);

const TriggeredBySchema = z
  .object({
    id: z.string(),
    name: z.string(),
    avatarUrl: z.string().nullable(),
  })
  .nullable();

const DeploymentSchema = z
  .object({
    id: z.string(),
    projectId: z.string(),
    status: DeploymentStatusEnum,
    trigger: DeploymentTriggerEnum,
    commitHash: z.string().nullable(),
    commitMessage: z.string().nullable(),
    branch: z.string().nullable(),
    errorMessage: z.string().nullable(),
    buildStartedAt: z.coerce.date().nullable(),
    buildFinishedAt: z.coerce.date().nullable(),
    deployStartedAt: z.coerce.date().nullable(),
    deployFinishedAt: z.coerce.date().nullable(),
    triggeredBy: TriggeredBySchema.optional(),
    createdAt: z.coerce.date(),
  })
  .openapi('Deployment');

const DeploymentLogsSchema = z
  .object({
    logs: z.string().nullable(),
    status: DeploymentStatusEnum,
  })
  .openapi('DeploymentLogs');

const MessageSchema = z
  .object({
    message: z.string(),
  })
  .openapi('DeploymentMessage');

// ============ Request Schemas ============

const CreateDeploymentSchema = z
  .object({
    commitHash: z.string().max(40).optional().openapi({ example: 'abc123def456' }),
    commitMessage: z.string().max(500).optional().openapi({ example: 'Fix bug in auth' }),
    branch: z.string().max(100).optional().openapi({ example: 'main' }),
  })
  .openapi('CreateDeployment');

// ============ Route Definitions ============

const listDeploymentsRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Deployments'],
  summary: 'List deployments',
  description: 'Get all deployments for a project',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
    query: z.object({
      limit: z.coerce.number().int().min(1).max(100).optional(),
      offset: z.coerce.number().int().min(0).optional(),
    }),
  },
  responses: {
    200: {
      description: 'List of deployments',
      content: {
        'application/json': {
          schema: z.object({
            data: z.array(DeploymentSchema),
          }),
        },
      },
    },
  },
});

const createDeploymentRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['Deployments'],
  summary: 'Create deployment',
  description: 'Trigger a new deployment for a project',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
    }),
    body: {
      content: {
        'application/json': {
          schema: CreateDeploymentSchema,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Deployment created',
      content: {
        'application/json': {
          schema: z.object({
            data: DeploymentSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const getDeploymentRoute = createRoute({
  method: 'get',
  path: '/{deploymentId}',
  tags: ['Deployments'],
  summary: 'Get deployment',
  description: 'Get a specific deployment',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      deploymentId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Deployment details',
      content: {
        'application/json': {
          schema: z.object({
            data: DeploymentSchema,
          }),
        },
      },
    },
  },
});

const cancelDeploymentRoute = createRoute({
  method: 'post',
  path: '/{deploymentId}/cancel',
  tags: ['Deployments'],
  summary: 'Cancel deployment',
  description: 'Cancel a pending or building deployment',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      deploymentId: z.string().uuid(),
    }),
  },
  responses: {
    200: {
      description: 'Deployment cancelled',
      content: {
        'application/json': {
          schema: z.object({
            data: DeploymentSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const redeployRoute = createRoute({
  method: 'post',
  path: '/{deploymentId}/redeploy',
  tags: ['Deployments'],
  summary: 'Redeploy',
  description: 'Create a new deployment with the same configuration',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      deploymentId: z.string().uuid(),
    }),
  },
  responses: {
    201: {
      description: 'Redeploy started',
      content: {
        'application/json': {
          schema: z.object({
            data: DeploymentSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const rollbackRoute = createRoute({
  method: 'post',
  path: '/{deploymentId}/rollback',
  tags: ['Deployments'],
  summary: 'Rollback',
  description: 'Rollback to a previous deployment',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      deploymentId: z.string().uuid(),
    }),
  },
  responses: {
    201: {
      description: 'Rollback started',
      content: {
        'application/json': {
          schema: z.object({
            data: DeploymentSchema,
            message: z.string(),
          }),
        },
      },
    },
  },
});

const getLogsRoute = createRoute({
  method: 'get',
  path: '/{deploymentId}/logs',
  tags: ['Deployments'],
  summary: 'Get deployment logs',
  description: 'Get build or deploy logs for a deployment',
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      projectId: z.string().uuid(),
      deploymentId: z.string().uuid(),
    }),
    query: z.object({
      type: z.enum(['build', 'deploy']).optional(),
    }),
  },
  responses: {
    200: {
      description: 'Deployment logs',
      content: {
        'application/json': {
          schema: z.object({
            data: DeploymentLogsSchema,
          }),
        },
      },
    },
  },
});

// ============ Router ============

const deploymentRouter = new OpenAPIHono<AppEnv>();

// All routes require authentication (supports both JWT and API key)
deploymentRouter.use('*', combinedAuthMiddleware);

// Scope requirements for API key access
deploymentRouter.get('/', requireScope('deployments:read'));
deploymentRouter.get('/:deploymentId', requireScope('deployments:read'));
deploymentRouter.get('/:deploymentId/logs', requireScope('deployments:read'));
deploymentRouter.get('/:deploymentId/logs/stream', requireScope('deployments:read'));
deploymentRouter.get('/:deploymentId/container-logs/stream', requireScope('deployments:read'));
deploymentRouter.post('/', requireScope('deployments:write'), deploymentRateLimiter);
deploymentRouter.post('/:deploymentId/cancel', requireScope('deployments:write'));
deploymentRouter.post('/:deploymentId/redeploy', requireScope('deployments:write'), deploymentRateLimiter);
deploymentRouter.post('/:deploymentId/rollback', requireScope('deployments:write'), deploymentRateLimiter);

// List deployments
deploymentRouter.openapi(listDeploymentsRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const { limit, offset } = c.req.valid('query');

  const deployments = await deploymentService.getByProject(
    projectId,
    organizationId,
    userId,
    locale,
    limit ?? 20,
    offset ?? 0
  );

  return c.json({ data: deployments });
});

// Create deployment
deploymentRouter.openapi(createDeploymentRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId } = c.req.valid('param');
  const input = c.req.valid('json');

  const deployment = await deploymentService.create(
    projectId,
    organizationId,
    userId,
    input,
    locale
  );

  // Log activity
  await activityService.logDeploymentCreated(
    organizationId,
    userId,
    projectId,
    deployment.id,
    input.branch,
    'manual',
    c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    c.req.header('user-agent')
  );

  return c.json(
    {
      data: deployment,
      message: t(locale, 'deployments', 'created'),
    },
    201
  );
});

// Get deployment
deploymentRouter.openapi(getDeploymentRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, deploymentId } = c.req.valid('param');

  const deployment = await deploymentService.getById(
    deploymentId,
    projectId,
    organizationId,
    userId,
    locale
  );

  return c.json({ data: deployment });
});

// Cancel deployment
deploymentRouter.openapi(cancelDeploymentRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, deploymentId } = c.req.valid('param');

  const deployment = await deploymentService.cancel(
    deploymentId,
    projectId,
    organizationId,
    userId,
    locale
  );

  // Log activity
  await activityService.log({
    organizationId,
    userId,
    projectId,
    action: 'deployment.cancelled',
    description: 'Cancelled deployment',
    metadata: { deploymentId },
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
  });

  return c.json({
    data: deployment,
    message: t(locale, 'deployments', 'cancelled'),
  });
});

// Redeploy
deploymentRouter.openapi(redeployRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, deploymentId } = c.req.valid('param');

  const deployment = await deploymentService.redeploy(
    deploymentId,
    projectId,
    organizationId,
    userId,
    locale
  );

  // Log activity
  await activityService.log({
    organizationId,
    userId,
    projectId,
    action: 'deployment.redeployed',
    description: 'Triggered redeploy',
    metadata: { originalDeploymentId: deploymentId, newDeploymentId: deployment.id },
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
  });

  return c.json(
    {
      data: deployment,
      message: t(locale, 'deployments', 'redeployStarted'),
    },
    201
  );
});

// Rollback
deploymentRouter.openapi(rollbackRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, deploymentId } = c.req.valid('param');

  const deployment = await deploymentService.rollback(
    deploymentId,
    projectId,
    organizationId,
    userId,
    locale
  );

  // Log activity
  await activityService.log({
    organizationId,
    userId,
    projectId,
    action: 'deployment.rolledback',
    description: 'Triggered rollback',
    metadata: { targetDeploymentId: deploymentId, newDeploymentId: deployment.id },
    ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
    userAgent: c.req.header('user-agent'),
  });

  return c.json(
    {
      data: deployment,
      message: t(locale, 'deployments', 'rollbackStarted'),
    },
    201
  );
});

// Get logs
deploymentRouter.openapi(getLogsRoute, async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const { projectId, deploymentId } = c.req.valid('param');
  const { type } = c.req.valid('query');

  const logs = await deploymentService.getLogs(
    deploymentId,
    projectId,
    organizationId,
    userId,
    locale,
    type ?? 'build'
  );

  return c.json({ data: logs });
});

// Stream container runtime logs (SSE)
deploymentRouter.get('/:deploymentId/container-logs/stream', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId') as string;
  const deploymentId = c.req.param('deploymentId') as string;

  // Validate access and get container name
  const deployment = await deploymentService.getDeploymentForStreaming(
    deploymentId,
    projectId,
    organizationId,
    userId,
    locale
  );

  // Only allow streaming for running deployments
  if (deployment.status !== 'running') {
    return c.json({ error: 'Container is not running' }, 400);
  }

  // Get project with server info
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
  });

  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  const containerName = `pushify-${project.slug}`;

  // Check if this is a remote deployment (project has a server assigned)
  if (project.serverId) {
    // Get server details
    const server = await db.query.servers.findFirst({
      where: eq(servers.id, project.serverId),
    });

    if (!server || !server.ipv4 || !server.sshPrivateKey) {
      return c.json({ error: 'Server not configured properly' }, 400);
    }

    // Connect via SSH and get logs
    let ssh: SSHClient | null = null;
    try {
      ssh = new SSHClient();
      await ssh.connect({
        host: server.ipv4,
        port: 22,
        username: 'root',
        privateKey: decrypt(server.sshPrivateKey),
      });

      // Check if container is running on remote server
      const running = await isRemoteContainerRunning(ssh, containerName);
      if (!running) {
        ssh.disconnect();
        return c.json({ error: 'Container is not running on remote server' }, 400);
      }

      // Get logs from remote server
      const logs = await getRemoteContainerLogs(ssh, containerName, { tail: 100 });
      ssh.disconnect();

      // Return logs as SSE response
      return new Response(
        new ReadableStream({
          start(controller) {
            const encoder = new TextEncoder();

            // Send initial message
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'connected', containerName, remote: true })}\n\n`)
            );

            // Send logs line by line
            const logLines = logs.split('\n');
            for (const line of logLines) {
              if (line.trim()) {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'log', message: line })}\n\n`)
                );
              }
            }

            // Send end message
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify({ type: 'end', message: 'Log stream ended' })}\n\n`)
            );

            controller.close();
          },
        }),
        {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        }
      );
    } catch (error) {
      if (ssh) {
        ssh.disconnect();
      }
      return c.json({ error: `Failed to get remote logs: ${error instanceof Error ? error.message : 'Unknown error'}` }, 500);
    }
  }

  // Local deployment - check if container is actually running
  const running = await isContainerRunning(containerName);
  if (!running) {
    return c.json({ error: 'Container is not running' }, 400);
  }

  // Set up SSE for container logs
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const abortController = new AbortController();

        // Send initial message
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'connected', containerName })}\n\n`)
        );

        try {
          await streamContainerLogs(
            containerName,
            (log) => {
              try {
                controller.enqueue(
                  encoder.encode(`data: ${JSON.stringify({ type: 'log', message: log })}\n\n`)
                );
              } catch {
                // Controller closed
                abortController.abort();
              }
            },
            { tail: 100, signal: abortController.signal }
          );
        } catch (error) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', message: String(error) })}\n\n`)
          );
        }

        controller.close();
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    }
  );
});

// Stream deployment build logs (SSE)
deploymentRouter.get('/:deploymentId/logs/stream', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId') as string;
  const deploymentId = c.req.param('deploymentId') as string;

  // Validate initial access
  const initialData = await deploymentService.getDeploymentForStreaming(
    deploymentId,
    projectId,
    organizationId,
    userId,
    locale
  );

  // Terminal statuses - no need to stream
  const terminalStatuses = ['running', 'failed', 'stopped', 'cancelled'];
  if (terminalStatuses.includes(initialData.status)) {
    return c.json({
      data: {
        status: initialData.status,
        logs: initialData.buildLogs,
        errorMessage: initialData.errorMessage,
        isComplete: true,
      },
    });
  }

  // Set up SSE using Hono's streaming helper
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let lastLogLength = 0;
        let lastStatus = initialData.status;
        const POLL_INTERVAL = 1000; // 1 second
        const MAX_DURATION = 10 * 60 * 1000; // 10 minutes max
        const startTime = Date.now();

        // Send initial data
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              status: initialData.status,
              logs: initialData.buildLogs || '',
              isComplete: false,
            })}\n\n`
          )
        );
        lastLogLength = (initialData.buildLogs || '').length;

        // Poll for updates
        while (Date.now() - startTime < MAX_DURATION) {
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));

          try {
            const data = await deploymentService.getDeploymentForStreaming(
              deploymentId,
              projectId,
              organizationId,
              userId,
              locale
            );

            const currentLogs = data.buildLogs || '';
            const isComplete = terminalStatuses.includes(data.status);

            // Check if there are new logs or status changed
            if (currentLogs.length > lastLogLength || data.status !== lastStatus) {
              const newLogs = currentLogs.substring(lastLogLength);

              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    status: data.status,
                    logs: newLogs,
                    errorMessage: data.errorMessage,
                    isComplete,
                  })}\n\n`
                )
              );

              lastLogLength = currentLogs.length;
              lastStatus = data.status;
            }

            // Stop streaming if deployment is complete
            if (isComplete) {
              break;
            }
          } catch {
            // Client disconnected or error occurred
            break;
          }
        }

        // Send final event and close
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ isComplete: true })}\n\n`));
        controller.close();
      },
    }),
    {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    }
  );
});

// Get historical container logs (persisted)
deploymentRouter.get('/:deploymentId/container-logs/history', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId') as string;
  const deploymentId = c.req.param('deploymentId') as string;
  const limit = parseInt(c.req.query('limit') || '10');
  const offset = parseInt(c.req.query('offset') || '0');

  // Validate access
  await deploymentService.getDeploymentForStreaming(
    deploymentId,
    projectId,
    organizationId,
    userId,
    locale
  );

  // Get historical logs from the database
  const { logs, totalChunks } = await getHistoricalLogs(deploymentId, {
    limit,
    offset,
  });

  return c.json({
    data: {
      logs: logs.map(log => ({
        content: log.content,
        timestamp: log.timestamp.toISOString(),
        lineCount: log.lineCount,
      })),
      pagination: {
        total: totalChunks,
        limit,
        offset,
        hasMore: offset + logs.length < totalChunks,
      },
    },
  });
});

export { deploymentRouter as deploymentRoutes };
