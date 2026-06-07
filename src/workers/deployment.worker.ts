import { db } from '../db';
import { deployments } from '../db/schema/deployments';
import { projects, environmentVariables } from '../db/schema/projects';
import { organizations } from '../db/schema/organizations';
import { gitIntegrations } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { decrypt } from '../lib/encryption';
import { logger } from '../lib/logger';
import { cloneRepository, cleanupRepository } from './git';
import {
  buildImage,
  runContainer,
  isDockerAvailable,
  isContainerRunning,
  findAvailablePort,
  getDockerImageSizeBytes,
} from './docker';
import { usageMeteringService } from '../services/usage-metering.service';
import { extractLogTail } from '../lib/log-tail';
import { generateDockerfile, hasDockerfile, writeDockerfile } from './dockerfile';
import { deployToRemoteServer, canDeployToServer, quickRollbackToDeployment } from './remote-deployment';
import { buildMarketplaceDeployConfig } from '../marketplace/deploy-config';
import { promises as fs } from 'fs';
import path from 'path';
import { githubService } from '../services/github.service';
import { notificationService } from '../services/notification.service';
import { activityService } from '../services/activity.service';
import { previewService } from '../services/preview.service';
import { previewRepository } from '../repositories/preview.repository';
import { getProjectGitAccessToken } from '../services/git-provider-access.service';
import { env } from '../config/env';
import { normalizeRootDirectory } from '../lib/normalize-root-directory';
import {
  buildQueueSnapshots,
  formatQueueStatusLine,
  mergeQueueLineIntoLogs,
} from '../lib/deploy-queue';
import {
  classifyDeployFailure,
  failureCategoryLogLine,
  formatClassifiedErrorMessage,
} from '../lib/deploy-failure-classify';
import { detectNextStandaloneFromConfig } from '../buildpacks/remote-detect';
import { wsManager } from '../lib/ws';
import {
  tryHoldDeployWorkerLeadership,
  releaseDeployWorkerLeadership,
} from '../lib/deploy-worker-lock';
import {
  tryAcquireDeploySlots,
  releaseDeploySlots,
  hasDeploySlotAvailable,
  getMemoryActiveDeploymentCount,
  getGlobalDeployActiveCount,
  getServerDeployActiveCount,
} from '../lib/deploy-concurrency';
import { isQueueAvailable } from '../lib/queue';

/**
 * Auto-detect framework from package.json
 */
async function detectFramework(workDir: string, rootDirectory: string = '.'): Promise<string | null> {
  try {
    const pkgPath = path.join(workDir, rootDirectory === '.' ? '' : rootDirectory, 'package.json');
    const pkgContent = await fs.readFile(pkgPath, 'utf-8');
    const pkg = JSON.parse(pkgContent);

    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Check for frameworks in order of specificity
    if (deps['next']) return 'nextjs';
    if (deps['nuxt']) return 'nuxt';
    if (deps['@sveltejs/kit']) return 'svelte';
    if (deps['astro']) return 'astro';
    if (deps['vue']) return 'vue';
    if (deps['react'] || deps['react-dom']) return 'react';
    if (deps['express'] || deps['fastify'] || deps['hono'] || deps['koa']) return 'nodejs';

    return 'nodejs'; // Default to nodejs if has package.json
  } catch {
    return null;
  }
}


const POLL_INTERVAL = 5000; // 5 seconds

let isRunning = false;
let useBullMqDeploy = false;

export interface DeploymentJob {
  id: string;
  projectId: string;
  branch: string | null;
  triggeredById: string | null;
  rollbackFromDeploymentId: string | null; // For quick rollback
  serverId: string | null; // Server ID for concurrency tracking
  isPreview: boolean;
  previewPrNumber: number | null;
  status?: string;
}

interface PreviewDeployContext {
  prNumber: number;
  containerName: string;
  previewUrl: string;
  deploySuffix: string;
}

async function loadPreviewDeployContext(
  job: DeploymentJob,
  projectSlug: string,
): Promise<PreviewDeployContext | null> {
  if (!job.isPreview || job.previewPrNumber == null) return null;

  const preview = await previewRepository.findByProjectAndPr(job.projectId, job.previewPrNumber);
  if (!preview) return null;

  const deploySuffix = `-pr-${preview.prNumber}`;
  return {
    prNumber: preview.prNumber,
    containerName: preview.containerName || `pushify-preview-${projectSlug}${deploySuffix}`,
    previewUrl:
      preview.previewUrl || previewService.generatePreviewUrl(projectSlug, preview.prNumber),
    deploySuffix,
  };
}

async function markPreviewBuilding(projectId: string, prNumber: number): Promise<void> {
  const preview = await previewRepository.findByProjectAndPr(projectId, prNumber);
  if (!preview) return;
  await previewRepository.update(preview.id, { status: 'building' });
}

const deploymentJobSelect = {
  id: deployments.id,
  projectId: deployments.projectId,
  branch: deployments.branch,
  triggeredById: deployments.triggeredById,
  rollbackFromDeploymentId: deployments.rollbackFromDeploymentId,
  isPreview: deployments.isPreview,
  previewPrNumber: deployments.previewPrNumber,
  serverId: projects.serverId,
};

interface GitHubStatusContext {
  accessToken: string;
  owner: string;
  repo: string;
  commitHash: string;
  deploymentId: string;
}

/**
 * Start the deployment worker
 */
export async function startDeploymentWorker(): Promise<void> {
  if (isRunning) {
    logger.warn('Deployment worker is already running');
    return;
  }

  // Note: Docker availability is checked per-deployment for local deployments only
  // Remote deployments use SSH to execute Docker commands on the remote server

  isRunning = true;
  useBullMqDeploy = isQueueAvailable();

  if (useBullMqDeploy) {
    const { startDeploymentQueueWorker } = await import('./deployment-queue.worker');
    startDeploymentQueueWorker();
    logger.info('🚀 Deployment worker started (BullMQ queue + reconcile loop)');
  } else {
    logger.info('🚀 Deployment worker started (DB poll — set REDIS_URL for BullMQ)');
    pollForDeployments();
  }
}

/**
 * Stop the deployment worker
 */
export function stopDeploymentWorker(): void {
  isRunning = false;
  if (useBullMqDeploy) {
    void import('./deployment-queue.worker').then((m) => m.stopDeploymentQueueWorker());
  }
  void releaseDeployWorkerLeadership();
  logger.info('Deployment worker stopped');
}

/**
 * Poll for pending deployments
 */
async function detectNextStandaloneLocal(workDir: string, rootDirectory: string): Promise<boolean> {
  const base = path.join(workDir, rootDirectory === '.' ? '' : rootDirectory);
  for (const name of ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']) {
    try {
      const content = await fs.readFile(path.join(base, name), 'utf-8');
      if (detectNextStandaloneFromConfig(content)) return true;
    } catch {
      /* no config file */
    }
  }
  return false;
}

export async function refreshPendingDeploymentQueueLogs(): Promise<void> {
  const pending = await db
    .select({
      id: deployments.id,
      serverId: projects.serverId,
      buildLogs: deployments.buildLogs,
    })
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(eq(deployments.status, 'pending'))
    .orderBy(deployments.createdAt);

  if (pending.length === 0) return;

  const globalActive = await getGlobalDeployActiveCount();
  const perServer = new Map<string, number>();
  for (const p of pending) {
    const sid = p.serverId || '__local__';
    if (!perServer.has(sid)) {
      perServer.set(sid, await getServerDeployActiveCount(sid));
    }
  }

  const snapshots = buildQueueSnapshots(
    pending.map((p) => ({ id: p.id, serverId: p.serverId })),
    perServer,
    globalActive,
  );

  for (const snap of snapshots) {
    const row = pending.find((p) => p.id === snap.deploymentId);
    const merged = mergeQueueLineIntoLogs(row?.buildLogs ?? null, formatQueueStatusLine(snap));
    await db
      .update(deployments)
      .set({ buildLogs: merged })
      .where(eq(deployments.id, snap.deploymentId));
  }
}

async function pollForDeployments(): Promise<void> {
  while (isRunning) {
    try {
      const isLeader = await tryHoldDeployWorkerLeadership();
      if (!isLeader) {
        await sleep(POLL_INTERVAL);
        continue;
      }

      await refreshPendingDeploymentQueueLogs();

      const job = await getNextEligibleDeployment();
      if (job) {
        const serverId = job.serverId || '__local__';
        const acquired = await tryAcquireDeploySlots(serverId);
        if (!acquired) {
          logger.debug(
            { deploymentId: job.id, serverId, limit: env.MAX_CONCURRENT_DEPLOYS_TOTAL },
            'Deploy concurrency limit reached, waiting...',
          );
        } else {
          logger.info({ deploymentId: job.id, serverId }, 'Deployment slot acquired (poll mode)');
          void executeDeploymentJob(job).finally(() => {
            void releaseDeploySlots(serverId);
            logger.info({ deploymentId: job.id, serverId }, 'Deployment slot released (poll mode)');
          });
        }
      }
    } catch (error) {
      logger.error({ err: error }, 'Error polling for deployments');
    }

    await sleep(POLL_INTERVAL);
  }
}

/**
 * Get next pending deployment from the queue
 */
async function getNextPendingDeployment(): Promise<DeploymentJob | null> {
  const result = await db
    .select(deploymentJobSelect)
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(eq(deployments.status, 'pending'))
    .orderBy(deployments.createdAt)
    .limit(10); // Fetch a batch to find an eligible one

  return result[0] || null;
}

/**
 * Get the next pending deployment that is eligible to run
 * (respects per-server concurrency limits)
 */
async function getNextEligibleDeployment(): Promise<DeploymentJob | null> {
  const pending = await db
    .select(deploymentJobSelect)
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(eq(deployments.status, 'pending'))
    .orderBy(deployments.createdAt)
    .limit(10); // Fetch a batch to find an eligible one

  for (const job of pending) {
    const serverId = job.serverId || '__local__';
    if (await hasDeploySlotAvailable(serverId)) {
      return job;
    }

    logger.debug(
      { deploymentId: job.id, serverId },
      'Server concurrency limit reached, skipping deployment this cycle',
    );
  }

  return null;
}

export async function loadDeploymentJobById(deploymentId: string): Promise<DeploymentJob | null> {
  const result = await db
    .select({
      ...deploymentJobSelect,
      status: deployments.status,
    })
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  return result[0] || null;
}

/**
 * Process a deployment
 */
export async function executeDeploymentJob(job: DeploymentJob): Promise<void> {
  const logBuffer: string[] = [];
  const addLog = (message: string) => {
    const timestamp = new Date().toISOString();
    logBuffer.push(`[${timestamp}] ${message}`);
    logger.info(`[Deployment ${job.id}] ${message}`);
  };

  let workDir: string | null = null;
  let githubStatusCtx: GitHubStatusContext | null = null;

  try {
    addLog('🚀 Starting deployment...');

    // Get project details
    const project = await db
      .select()
      .from(projects)
      .where(eq(projects.id, job.projectId))
      .limit(1)
      .then((r) => r[0]);

    if (!project) {
      throw new Error('Project not found');
    }

    const previewCtx = await loadPreviewDeployContext(job, project.slug);
    if (previewCtx) {
      addLog(`🔍 Preview deployment for PR #${previewCtx.prNumber}`);
      await markPreviewBuilding(job.projectId, previewCtx.prNumber);
    }

    // Check if project is active
    if (project.status !== 'active') {
      throw new Error('Project is not active');
    }

    const [org] = await db
      .select({ billingStatus: organizations.billingStatus })
      .from(organizations)
      .where(eq(organizations.id, project.organizationId))
      .limit(1);

    if (org?.billingStatus === 'past_due' || org?.billingStatus === 'suspended') {
      throw new Error('Organization billing does not allow deployments');
    }

    // Update status to building
    await updateDeploymentStatus(job.id, 'building', logBuffer.join('\n'), job.projectId);
    addLog('📦 Status: Building');

    // Send deployment started notification
    await notificationService.sendNotifications(job.projectId, 'deployment.started', {
      deploymentId: job.id,
      branch: job.branch || project.gitBranch || 'main',
      message: 'Deployment has started',
      url: `${env.FRONTEND_URL}/dashboard/projects/${job.projectId}?tab=deployments&deployment=${job.id}`,
    });

    // Get GitHub access token if available
    let accessToken: string | undefined;
    const projectSettings = project.settings as Record<string, unknown>;
    const prStatusChecksEnabled = projectSettings?.prStatusChecksEnabled === true;

    const projectGitAuth = await getProjectGitAccessToken(job.projectId);
    if (projectGitAuth) {
      accessToken = projectGitAuth.token;
      addLog(`🔑 Using ${projectGitAuth.provider} credentials from organization owner`);
    } else if (project.gitRepoUrl?.includes('github.com') && job.triggeredById) {
      const integration = await db.query.gitIntegrations.findFirst({
        where: and(
          eq(gitIntegrations.userId, job.triggeredById),
          eq(gitIntegrations.provider, 'github'),
        ),
      });

      if (integration) {
        accessToken = decrypt(integration.accessToken);
        addLog('🔑 Using GitHub credentials from user');
      }
    }

    // Check if project has a server assigned for remote deployment
    if (project.serverId) {
      addLog('🖥️ Project has a remote server assigned, using remote deployment...');

      // Verify server is ready for deployment
      const serverCheck = await canDeployToServer(project.serverId);
      if (!serverCheck.canDeploy) {
        throw new Error(`Server not ready for deployment: ${serverCheck.reason}`);
      }

      // Get environment variables
      const envVars = await db
        .select()
        .from(environmentVariables)
        .where(eq(environmentVariables.projectId, job.projectId));

      const envVarsDecrypted: Record<string, string> = {};
      for (const envVar of envVars) {
        envVarsDecrypted[envVar.key] = decrypt(envVar.valueEncrypted);
      }

      // Check for quick rollback (uses existing Docker image, no rebuild)
      if (job.rollbackFromDeploymentId) {
        addLog('⚡ Quick rollback detected - using existing Docker image...');

        // Get the source deployment
        const sourceDeployment = await db
          .select()
          .from(deployments)
          .where(eq(deployments.id, job.rollbackFromDeploymentId))
          .limit(1)
          .then((r) => r[0]);

        if (!sourceDeployment || !sourceDeployment.dockerImageId) {
          addLog('⚠️ Quick rollback unavailable - source image not found, falling back to full rebuild');
        } else {
          // Perform quick rollback
          await updateDeploymentStatus(job.id, 'deploying', logBuffer.join('\n'), job.projectId);
          addLog('🚀 Status: Rolling back (no build required)');

          const rollbackResult = await quickRollbackToDeployment({
            serverId: project.serverId,
            projectId: project.id,
            projectSlug: project.slug,
            targetDeploymentId: job.rollbackFromDeploymentId,
            port: project.port || 3000,
            envVars: envVarsDecrypted,
            onProgress: (message) => {
              addLog(message);
              // Flush logs to database
              db.update(deployments)
                .set({ buildLogs: logBuffer.join('\n') })
                .where(eq(deployments.id, job.id))
                .catch((err) => logger.error({ err }, 'Failed to flush deployment logs'));
            },
          });

          if (!rollbackResult.success) {
            throw new Error(rollbackResult.error || 'Quick rollback failed');
          }

          // Update deployment as successful
          await db
            .update(deployments)
            .set({
              status: 'running',
              buildLogs: logBuffer.join('\n'),
              deployFinishedAt: new Date(),
              dockerImageId: sourceDeployment.dockerImageId, // Copy the image ID
              containerPort: rollbackResult.containerPort || null,
            })
            .where(eq(deployments.id, job.id));

          // Update project with production URL
          await db
            .update(projects)
            .set({
              settings: {
                ...(project.settings as Record<string, unknown>),
                productionUrl: rollbackResult.deploymentUrl,
                lastDeploymentId: job.id,
              },
              updatedAt: new Date(),
            })
            .where(eq(projects.id, job.projectId));

          // Publish running status via WebSocket
          wsManager.publish(`project:${job.projectId}`, {
            type: 'deployment:status',
            data: { projectId: job.projectId, deploymentId: job.id, status: 'running' },
          }).catch(() => {});

          addLog(`✅ Quick rollback successful! URL: ${rollbackResult.deploymentUrl}`);
          logger.info(`Deployment ${job.id} completed successfully (quick rollback)`);

          // Log activity
          await activityService.logDeploymentSucceeded(
            project.organizationId,
            job.projectId,
            job.id
          );

          // Send deployment success notification
          await notificationService.sendNotifications(job.projectId, 'deployment.success', {
            deploymentId: job.id,
            branch: sourceDeployment.branch || undefined,
            commitHash: sourceDeployment.commitHash || undefined,
            status: 'running',
            message: 'Quick rollback completed successfully',
            url: rollbackResult.deploymentUrl,
          });

          return; // Exit early for quick rollback
        }
      }

      // Check if this is a marketplace project (skip git clone)
      const isMarketplace = !!(projectSettings?.marketplaceTemplateId);

      let localClone: { workDir: string; branch: string; commitHash: string; commitMessage: string } | null = null;

      if (isMarketplace) {
        addLog(`📦 Marketplace app: ${projectSettings.marketplaceTemplateId}`);
        addLog('⏭️ Skipping git clone — using Docker image directly');
      } else {
        // Get commit hash from remote clone
        const branch = job.branch || project.gitBranch || undefined;

        if (branch) {
          addLog(`🌿 Using branch: ${branch}${job.branch ? ' (from trigger)' : ' (from project settings)'}`);
        } else {
          addLog(`🌿 No branch specified, will use repository default`);
        }

        if (!project.gitRepoUrl) {
          throw new Error('No repository URL configured');
        }

        // Clone locally just to get commit info
        localClone = await cloneRepository({
          repoUrl: project.gitRepoUrl,
          branch,
          accessToken,
          onProgress: addLog,
        });
        workDir = localClone.workDir;
      }

      // Update commit info
      if (localClone) {
        await db
          .update(deployments)
          .set({
            commitHash: localClone.commitHash,
            commitMessage: localClone.commitMessage,
            buildLogs: logBuffer.join('\n'),
          })
          .where(eq(deployments.id, job.id));
      }

      // Set up GitHub status context
      if (localClone && prStatusChecksEnabled && accessToken && project.gitRepoUrl) {
        const repoInfo = githubService.parseRepoFromUrl(project.gitRepoUrl);
        if (repoInfo) {
          githubStatusCtx = {
            accessToken,
            owner: repoInfo.owner,
            repo: repoInfo.repo,
            commitHash: localClone.commitHash,
            deploymentId: job.id,
          };

          const logsUrl = `${env.FRONTEND_URL}/dashboard/projects/${project.id}?tab=deployments&deployment=${job.id}`;
          await githubService.setCommitStatus(
            githubStatusCtx.accessToken,
            githubStatusCtx.owner,
            githubStatusCtx.repo,
            githubStatusCtx.commitHash,
            'pending',
            'Deployment in progress...',
            logsUrl
          );
          addLog('📋 GitHub status: pending');
        }
      }

      // Perform remote deployment
      await updateDeploymentStatus(job.id, 'deploying', logBuffer.join('\n'), job.projectId);
      addLog('🚀 Status: Deploying to remote server');

      // Create a progress handler that both adds to buffer AND saves to DB
      // Uses fire-and-forget pattern to not block the deployment process
      const onRemoteProgress = (message: string) => {
        addLog(message);
        // Flush logs to database so streaming endpoint can see them (fire-and-forget)
        db.update(deployments)
          .set({ buildLogs: logBuffer.join('\n') })
          .where(eq(deployments.id, job.id))
          .catch((err) => logger.error({ err }, 'Failed to flush deployment logs'));
      };

      // Marketplace: always load latest template from codebase (not stale project.settings.composeFile)
      const marketplaceConfig = projectSettings?.marketplaceTemplateId
        ? buildMarketplaceDeployConfig(
            projectSettings.marketplaceTemplateId as string,
            projectSettings as Record<string, unknown>
          )
        : undefined;

      let deployFramework = (projectSettings?.framework as string) || undefined;
      let deployBuildpackId: string | undefined;
      if (localClone) {
        const { detectBuildpack } = await import('../buildpacks');
        const localDetection = await detectBuildpack(
          localClone.workDir,
          normalizeRootDirectory(project.rootDirectory)
        );
        if (localDetection && localDetection.buildpackId !== 'custom') {
          deployFramework = localDetection.framework;
          deployBuildpackId = localDetection.buildpackId;
          addLog(`✅ Detected: ${localDetection.buildpackId} (${localDetection.framework})`);
        }
      }

      const remoteResult = await deployToRemoteServer({
        serverId: project.serverId,
        projectId: project.id,
        projectSlug: project.slug,
        deploymentId: job.id,
        repoUrl: project.gitRepoUrl || '',
        branch: localClone?.branch || job.branch || 'main',
        commitHash: localClone?.commitHash || 'marketplace',
        port: project.port || 3000,
        envVars: envVarsDecrypted,
        buildCommand: project.buildCommand || undefined,
        startCommand: project.startCommand || undefined,
        installCommand: project.installCommand || (projectSettings?.installCommand as string) || 'npm install --legacy-peer-deps',
        rootDirectory: normalizeRootDirectory(project.rootDirectory),
        dockerfilePath: project.dockerfilePath || undefined,
        outputDirectory: (projectSettings?.outputDirectory as string) || undefined,
        framework: deployFramework,
        buildpackId: deployBuildpackId,
        accessToken,
        onProgress: onRemoteProgress,
        marketplace: marketplaceConfig,
        deploySuffix: previewCtx?.deploySuffix,
      });

      if (!remoteResult.success) {
        throw new Error(remoteResult.error || 'Remote deployment failed');
      }

      // Update deployment as successful (including image info for rollback)
      await db
        .update(deployments)
        .set({
          status: 'running',
          buildLogs: logBuffer.join('\n'),
          deployFinishedAt: new Date(),
          dockerImageId: remoteResult.dockerImageId || null,
          containerPort: remoteResult.containerPort || null,
        })
        .where(eq(deployments.id, job.id));

      const successUrl = previewCtx ? previewCtx.previewUrl : remoteResult.deploymentUrl;

      if (previewCtx) {
        await previewService.updatePreviewStatus(
          job.projectId,
          previewCtx.prNumber,
          'running',
          remoteResult.containerPort ?? undefined,
        );
        addLog(`✅ Preview deployment live: ${successUrl}`);
      } else {
        // Update project with production URL (+ refresh marketplace compose from latest template)
        const settingsUpdate: Record<string, unknown> = {
          ...(project.settings as Record<string, unknown>),
          productionUrl: remoteResult.deploymentUrl,
          lastDeploymentId: job.id,
        };
        if (marketplaceConfig && projectSettings?.marketplaceTemplateId) {
          settingsUpdate.composeFile = marketplaceConfig.composeFile ?? settingsUpdate.composeFile;
          settingsUpdate.composePublicService =
            marketplaceConfig.composePublicService ?? settingsUpdate.composePublicService;
          settingsUpdate.composePublicPort =
            marketplaceConfig.composePublicPort ?? settingsUpdate.composePublicPort;
          settingsUpdate.extraFiles = marketplaceConfig.extraFiles ?? settingsUpdate.extraFiles;
        }
        await db
          .update(projects)
          .set({
            settings: settingsUpdate,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, job.projectId));
        addLog(`✅ Remote deployment successful! URL: ${remoteResult.deploymentUrl}`);
      }

      // Publish running status via WebSocket
      wsManager.publish(`project:${job.projectId}`, {
        type: 'deployment:status',
        data: { projectId: job.projectId, deploymentId: job.id, status: 'running' },
      }).catch(() => {});
      logger.info(`Deployment ${job.id} completed successfully (remote)`);

      // Log activity
      await activityService.logDeploymentSucceeded(
        project.organizationId,
        job.projectId,
        job.id
      );

      // Update GitHub status to success
      if (githubStatusCtx) {
        const logsUrl = `${env.FRONTEND_URL}/dashboard/projects/${job.projectId}?tab=deployments&deployment=${job.id}`;
        await githubService.setCommitStatus(
          githubStatusCtx.accessToken,
          githubStatusCtx.owner,
          githubStatusCtx.repo,
          githubStatusCtx.commitHash,
          'success',
          'Deployment successful!',
          logsUrl
        );
        addLog('📋 GitHub status: success');
      }

      // Send deployment success notification
      if (!previewCtx) {
        await notificationService.sendNotifications(job.projectId, 'deployment.success', {
          deploymentId: job.id,
          branch: localClone?.branch || 'main',
          commitHash: localClone?.commitHash || 'marketplace',
          status: 'running',
          message: 'Deployment completed successfully',
          url: remoteResult.deploymentUrl,
        });
      }

      return; // Exit early for remote deployment
    }

    // === LOCAL DEPLOYMENT (fallback when no server assigned) ===

    // Get environment variables early (needed for Dockerfile generation + build args)
    const localEnvVars = await db
      .select()
      .from(environmentVariables)
      .where(eq(environmentVariables.projectId, job.projectId));

    const envVarsDecrypted: Record<string, string> = {};
    for (const ev of localEnvVars) {
      envVarsDecrypted[ev.key] = decrypt(ev.valueEncrypted);
    }

    // Check Docker availability for local deployment
    const dockerAvailable = await isDockerAvailable();
    if (!dockerAvailable) {
      throw new Error('Docker is not available on this machine. Please assign a server to this project for remote deployment, or install Docker locally.');
    }

    // Clone repository
    addLog(`📥 Cloning repository: ${project.gitRepoUrl}`);
    // Use specified branch, or project's configured branch, or let git use default
    const branch = job.branch || project.gitBranch || undefined;

    if (branch) {
      addLog(`🌿 Using branch: ${branch}${job.branch ? ' (from trigger)' : ' (from project settings)'}`);
    } else {
      addLog(`🌿 No branch specified, will use repository default`);
    }

    if (!project.gitRepoUrl) {
      throw new Error('No repository URL configured');
    }

    const cloneResult = await cloneRepository({
      repoUrl: project.gitRepoUrl,
      branch,
      accessToken,
      onProgress: addLog,
    });

    workDir = cloneResult.workDir;

    // Update commit info
    await db
      .update(deployments)
      .set({
        commitHash: cloneResult.commitHash,
        commitMessage: cloneResult.commitMessage,
        buildLogs: logBuffer.join('\n'),
      })
      .where(eq(deployments.id, job.id));

    // Set up GitHub status context if PR status checks are enabled
    if (prStatusChecksEnabled && accessToken && project.gitRepoUrl) {
      const repoInfo = githubService.parseRepoFromUrl(project.gitRepoUrl);
      if (repoInfo) {
        githubStatusCtx = {
          accessToken,
          owner: repoInfo.owner,
          repo: repoInfo.repo,
          commitHash: cloneResult.commitHash,
          deploymentId: job.id,
        };

        // Set pending status on GitHub
        const logsUrl = `${env.FRONTEND_URL}/dashboard/projects/${project.id}?tab=deployments&deployment=${job.id}`;
        await githubService.setCommitStatus(
          githubStatusCtx.accessToken,
          githubStatusCtx.owner,
          githubStatusCtx.repo,
          githubStatusCtx.commitHash,
          'pending',
          'Deployment in progress...',
          logsUrl
        );
        addLog('📋 GitHub status: pending');
      }
    }

    // Check/generate Dockerfile
    const hasExistingDockerfile = await hasDockerfile(workDir, project.dockerfilePath || undefined);

    if (!hasExistingDockerfile) {
      // Use buildpack system for auto-detection
      const { detectBuildpack, getBuildpack } = await import('../buildpacks');

      addLog('🔍 Auto-detecting language and framework...');
      const detection = await detectBuildpack(workDir, project.rootDirectory || '.');

      let dockerfileContent: string;
      const fw = detection?.framework;
      const nextStandalone =
        fw === 'nextjs'
          ? await detectNextStandaloneLocal(workDir, project.rootDirectory || '.')
          : false;
      if (nextStandalone) addLog('📦 Next.js standalone detected — smaller production image');

      const dockerGenBase = {
        buildCommand: project.buildCommand,
        installCommand:
          project.installCommand ||
          (project.settings as Record<string, string>)?.installCommand ||
          'npm install --legacy-peer-deps',
        startCommand: project.startCommand,
        outputDirectory: (project.settings as Record<string, string>)?.outputDirectory || null,
        rootDirectory: project.rootDirectory || '.',
        envVars: envVarsDecrypted,
        nextStandalone,
      };

      if (detection && detection.buildpackId !== 'custom') {
        const buildpack = getBuildpack(detection.buildpackId);
        if (buildpack) {
          addLog(`✅ Detected: ${buildpack.name} (${detection.framework})`);
          addLog('📄 Generating optimized Dockerfile...');
          dockerfileContent = buildpack.generateDockerfile({
            ...dockerGenBase,
            framework: detection.framework,
            port: project.port || buildpack.getDefaultPort(detection.framework),
          } as any);
        } else {
          addLog('⚠️ Buildpack not found, falling back to generic');
          dockerfileContent = generateDockerfile({
            ...dockerGenBase,
            framework: null,
            port: project.port || 3000,
          });
        }
      } else {
        addLog('⚠️ Could not detect language, falling back to Node.js');
        dockerfileContent = generateDockerfile({
          ...dockerGenBase,
          framework: 'nodejs',
          port: project.port || 3000,
        });
      }

      await writeDockerfile(workDir, dockerfileContent);
      addLog('✅ Dockerfile generated');
    } else {
      addLog('✅ Using existing Dockerfile');
    }

    // Build Docker image
    const imageSlug = previewCtx ? `${project.slug}${previewCtx.deploySuffix}` : project.slug;
    const imageName = `pushify/${imageSlug}`;
    const imageTag = cloneResult.commitHash.substring(0, 7);

    addLog(`🔨 Building image: ${imageName}:${imageTag}`);
    await updateDeploymentStatus(job.id, 'building', logBuffer.join('\n'), job.projectId);

    // Pass all env vars as build args
    const buildArgs: Record<string, string> = { ...envVarsDecrypted };

    await buildImage({
      workDir,
      imageName,
      tag: imageTag,
      dockerfilePath: project.dockerfilePath || undefined,
      buildArgs: Object.keys(buildArgs).length > 0 ? buildArgs : undefined,
      onProgress: addLog,
    });

    try {
      const imageBytes = await getDockerImageSizeBytes(`${imageName}:${imageTag}`);
      await usageMeteringService.addDeployStorageBytes(project.organizationId, imageBytes);
    } catch {
      // Non-fatal — metering must not block deploy
    }

    // Update status to deploying
    await updateDeploymentStatus(job.id, 'deploying', logBuffer.join('\n'), job.projectId);
    addLog('🚀 Status: Deploying');

    // Run container (envVarsDecrypted already loaded above)
    const containerName =
      previewCtx?.containerName ?? `pushify-${project.slug}`;

    // Container port is what the app listens on inside the container
    const containerPort = project.port || 3000;

    // Find an available host port (start from 5000 to avoid conflicts with common dev servers)
    addLog(`🔍 Finding available host port starting from 5000...`);
    const hostPort = await findAvailablePort(5000);

    addLog(`🐳 Starting container: ${containerName} (host:${hostPort} -> container:${containerPort})`);

    await runContainer({
      imageName: `${imageName}:${imageTag}`,
      containerName,
      hostPort,
      containerPort,
      envVars: envVarsDecrypted,
      onProgress: addLog,
    });

    // Verify container is running
    await sleep(2000);
    const containerRunning = await isContainerRunning(containerName);

    if (!containerRunning) {
      throw new Error('Container failed to start');
    }

    // Create auto subdomain if no domain exists
    let deploymentUrl = previewCtx
      ? previewCtx.previewUrl
      : `http://localhost:${hostPort}`;
    try {
      if (previewCtx) {
        addLog(`🌐 Preview URL: ${deploymentUrl}`);
      }

      const { domainService } = await import('../services/domain.service');
      const { domains: domainsTable } = await import('../db/schema/projects');
      const existingDomain = await db.query.domains.findFirst({
        where: eq(domainsTable.projectId, job.projectId),
        orderBy: (domains, { desc }) => [desc(domains.isPrimary)],
      });

      if (previewCtx && env.PREVIEW_BASE_URL) {
        const domainName = deploymentUrl.replace(/^https?:\/\//, '').split('/')[0];
        addLog(`🌐 Configuring Nginx for preview: ${domainName}`);
        const sslCertPath =
          env.WILDCARD_SSL_PATH || `/etc/letsencrypt/live/${env.PREVIEW_BASE_URL}`;
        const nginxConfig = `# Pushify preview: ${project.slug} PR ${previewCtx.prNumber}
server {
    listen 80;
    server_name ${domainName};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name ${domainName};

    ssl_certificate ${sslCertPath}/fullchain.pem;
    ssl_certificate_key ${sslCertPath}/privkey.pem;

    location / {
        proxy_pass http://localhost:${hostPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
        try {
          const { execSync } = await import('child_process');
          const confPath = `/etc/nginx/conf.d/preview-${project.slug}-pr-${previewCtx.prNumber}.conf`;
          await fs.writeFile(confPath, nginxConfig);
          execSync('nginx -t && nginx -s reload', { timeout: 10000 });
          addLog(`✅ Nginx configured for preview ${domainName}`);
        } catch (nginxError) {
          addLog(
            `⚠️ Preview nginx skipped: ${nginxError instanceof Error ? nginxError.message : 'Unknown error'}`,
          );
        }
      } else if (existingDomain) {
        deploymentUrl = `https://${existingDomain.domain}`;
        addLog(`🌐 Using existing domain: ${existingDomain.domain}`);
      } else if (env.PREVIEW_BASE_URL) {
        addLog('🌐 No domain configured, creating auto subdomain...');
        const autoDomain = await domainService.createAutoSubdomain(job.projectId, project.slug, '');
        if (autoDomain) {
          deploymentUrl = `https://${autoDomain.domain}`;
          addLog(`✅ Auto subdomain created: ${autoDomain.domain}`);
        }
      }

      // Write Nginx config for the subdomain/domain
      const domainName = deploymentUrl.replace(/^https?:\/\//, '');
      if (domainName && domainName !== `localhost:${hostPort}`) {
        addLog(`🌐 Configuring Nginx for: ${domainName}`);
        const sslCertPath = env.WILDCARD_SSL_PATH
          || (env.PREVIEW_BASE_URL ? `/etc/letsencrypt/live/${env.PREVIEW_BASE_URL}` : `/etc/letsencrypt/live/${domainName}`);

        const nginxConfig = `# Pushify auto-generated: ${project.slug}
server {
    listen 80;
    server_name ${domainName};
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name ${domainName};

    ssl_certificate ${sslCertPath}/fullchain.pem;
    ssl_certificate_key ${sslCertPath}/privkey.pem;

    location / {
        proxy_pass http://localhost:${hostPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;
    }
}
`;
        try {
          const { execSync } = await import('child_process');
          const confPath = `/etc/nginx/conf.d/${project.slug}.pushify.dev.conf`;
          await fs.writeFile(confPath, nginxConfig);
          execSync('nginx -t && nginx -s reload', { timeout: 10000 });
          addLog(`✅ Nginx configured for ${domainName}`);
        } catch (nginxError) {
          addLog(`⚠️ Nginx config skipped: ${nginxError instanceof Error ? nginxError.message : 'Unknown error'}`);
        }
      }
    } catch (subdomainError) {
      addLog(`⚠️ Subdomain setup skipped: ${subdomainError instanceof Error ? subdomainError.message : 'Unknown error'}`);
    }
    await db
      .update(deployments)
      .set({
        status: 'running',
        buildLogs: logBuffer.join('\n'),
        deployFinishedAt: new Date(),
      })
      .where(eq(deployments.id, job.id));

    if (previewCtx) {
      await previewService.updatePreviewStatus(
        job.projectId,
        previewCtx.prNumber,
        'running',
        hostPort,
      );
      addLog(`✅ Preview deployment successful! URL: ${deploymentUrl}`);
    } else {
      await db
        .update(projects)
        .set({
          settings: {
            ...(project.settings as Record<string, unknown>),
            productionUrl: deploymentUrl,
            lastDeploymentId: job.id,
          },
          updatedAt: new Date(),
        })
        .where(eq(projects.id, job.projectId));
      addLog(`✅ Deployment successful! URL: ${deploymentUrl}`);
    }

    logger.info(`Deployment ${job.id} completed successfully`);

    // Publish running status via WebSocket
    wsManager.publish(`project:${job.projectId}`, {
      type: 'deployment:status',
      data: { projectId: job.projectId, deploymentId: job.id, status: 'running' },
    }).catch(() => {});

    // Log activity
    await activityService.logDeploymentSucceeded(
      project.organizationId,
      job.projectId,
      job.id
    );

    // Update GitHub status to success
    if (githubStatusCtx) {
      const logsUrl = `${env.FRONTEND_URL}/dashboard/projects/${job.projectId}?tab=deployments&deployment=${job.id}`;
      await githubService.setCommitStatus(
        githubStatusCtx.accessToken,
        githubStatusCtx.owner,
        githubStatusCtx.repo,
        githubStatusCtx.commitHash,
        'success',
        'Deployment successful!',
        logsUrl
      );
      addLog('📋 GitHub status: success');
    }

    if (!previewCtx) {
      await notificationService.sendNotifications(job.projectId, 'deployment.success', {
        deploymentId: job.id,
        branch: cloneResult.branch,
        commitHash: cloneResult.commitHash,
        status: 'running',
        message: 'Deployment completed successfully',
        url: deploymentUrl,
      });
    }
  } catch (error) {
    const rawError = error instanceof Error ? error.message : String(error);
    const classified = classifyDeployFailure(logBuffer.join('\n'), rawError);
    addLog(failureCategoryLogLine(classified.category));
    addLog(`💡 ${classified.userHint}`);
    addLog(`❌ Deployment failed: ${rawError}`);
    const errorMessage = formatClassifiedErrorMessage(classified, rawError);

    // Get project for organizationId
    const failedProject = await db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, job.projectId))
      .limit(1)
      .then((r) => r[0]);

    await markDeploymentFailed(job.id, errorMessage, logBuffer.join('\n'));

    if (job.isPreview && job.previewPrNumber != null) {
      await previewService.updatePreviewStatus(job.projectId, job.previewPrNumber, 'failed');
    }

    // Publish failed status via WebSocket
    wsManager.publish(`project:${job.projectId}`, {
      type: 'deployment:status',
      data: { projectId: job.projectId, deploymentId: job.id, status: 'failed', message: errorMessage },
    }).catch(() => {});

    // Log activity
    if (failedProject) {
      await activityService.logDeploymentFailed(
        failedProject.organizationId,
        job.projectId,
        job.id,
        errorMessage
      );
    }

    // Update GitHub status to failure
    if (githubStatusCtx) {
      const logsUrl = `${env.FRONTEND_URL}/dashboard/projects/${job.projectId}?tab=deployments&deployment=${job.id}`;
      await githubService.setCommitStatus(
        githubStatusCtx.accessToken,
        githubStatusCtx.owner,
        githubStatusCtx.repo,
        githubStatusCtx.commitHash,
        'failure',
        `Deployment failed: ${errorMessage.substring(0, 100)}`,
        logsUrl
      );
      addLog('📋 GitHub status: failure');
    }

    const logTail = extractLogTail(logBuffer.join('\n'), 20);

    await notificationService.sendNotifications(job.projectId, 'deployment.failed', {
      deploymentId: job.id,
      branch: job.branch || undefined,
      status: 'failed',
      message: errorMessage,
      logTail,
      url: `${env.FRONTEND_URL}/dashboard/projects/${job.projectId}?tab=deployments&deployment=${job.id}`,
    });

    logger.error({ err: error, deploymentId: job.id }, 'Deployment failed');
  } finally {
    // Cleanup
    if (workDir) {
      addLog('🧹 Cleaning up...');
      await cleanupRepository(workDir);
    }

    // Final log update
    await db
      .update(deployments)
      .set({
        buildLogs: logBuffer.join('\n'),
      })
      .where(eq(deployments.id, job.id));
  }
}

/**
 * Mark deployment failed and close build window for quota metering when a build had started.
 */
async function markDeploymentFailed(
  deploymentId: string,
  errorMessage: string,
  buildLogs: string,
): Promise<void> {
  const [row] = await db
    .select({
      buildStartedAt: deployments.buildStartedAt,
      buildFinishedAt: deployments.buildFinishedAt,
    })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);

  const now = new Date();
  const patch: {
    status: 'failed';
    errorMessage: string;
    buildLogs: string;
    buildFinishedAt?: Date;
  } = {
    status: 'failed',
    errorMessage,
    buildLogs,
  };

  if (row?.buildStartedAt && !row?.buildFinishedAt) {
    patch.buildFinishedAt = now;
  }

  await db.update(deployments).set(patch).where(eq(deployments.id, deploymentId));
}

/**
 * Update deployment status with logs
 */
async function updateDeploymentStatus(
  deploymentId: string,
  status: 'pending' | 'building' | 'deploying' | 'running' | 'failed' | 'stopped' | 'cancelled',
  logs?: string,
  projectId?: string
): Promise<void> {
  const updateData: Record<string, unknown> = { status };

  const now = new Date();
  switch (status) {
    case 'building':
      updateData.buildStartedAt = now;
      break;
    case 'deploying':
      updateData.buildFinishedAt = now;
      updateData.deployStartedAt = now;
      break;
    case 'running':
      updateData.deployFinishedAt = now;
      break;
    case 'failed':
    case 'cancelled': {
      const [row] = await db
        .select({
          buildStartedAt: deployments.buildStartedAt,
          buildFinishedAt: deployments.buildFinishedAt,
        })
        .from(deployments)
        .where(eq(deployments.id, deploymentId))
        .limit(1);
      if (row?.buildStartedAt && !row?.buildFinishedAt) {
        updateData.buildFinishedAt = now;
      }
      break;
    }
  }

  if (logs) {
    updateData.buildLogs = logs;
  }

  await db
    .update(deployments)
    .set(updateData)
    .where(eq(deployments.id, deploymentId));

  // Publish WebSocket event for status transitions
  if (projectId) {
    wsManager.publish(`project:${projectId}`, {
      type: 'deployment:status',
      data: { projectId, deploymentId, status },
    }).catch(() => {});
  }
}


/**
 * Sleep utility
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check if worker is currently running
 */
export function isWorkerRunning(): boolean {
  return isRunning;
}

/**
 * Get current number of active deployments
 */
export function getActiveDeploymentCount(): number {
  return getMemoryActiveDeploymentCount();
}
