import { db } from '../db';
import { deployments } from '../db/schema/deployments';
import { projects, environmentVariables } from '../db/schema/projects';
import { gitIntegrations } from '../db/schema';
import { eq, and, inArray } from 'drizzle-orm';
import { decrypt } from '../lib/encryption';
import { logger } from '../lib/logger';
import { cloneRepository, cleanupRepository } from './git';
import { buildImage, runContainer, isDockerAvailable, isContainerRunning, findAvailablePort } from './docker';
import { generateDockerfile, hasDockerfile, writeDockerfile } from './dockerfile';
import { deployToRemoteServer, canDeployToServer, quickRollbackToDeployment } from './remote-deployment';
import { promises as fs } from 'fs';
import path from 'path';
import { githubService } from '../services/github.service';
import { notificationService } from '../services/notification.service';
import { activityService } from '../services/activity.service';
import { env } from '../config/env';
import { wsManager } from '../lib/ws';

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
let activeDeployments = 0;

// Per-server concurrency tracking
const activeDeploymentsPerServer = new Map<string, number>();

function canDeployToServerSlot(serverId: string): boolean {
  const active = activeDeploymentsPerServer.get(serverId) || 0;
  return active < env.MAX_CONCURRENT_DEPLOYS_PER_SERVER;
}

function incrementServerDeploys(serverId: string): void {
  const active = activeDeploymentsPerServer.get(serverId) || 0;
  activeDeploymentsPerServer.set(serverId, active + 1);
}

function decrementServerDeploys(serverId: string): void {
  const active = activeDeploymentsPerServer.get(serverId) || 0;
  activeDeploymentsPerServer.set(serverId, Math.max(0, active - 1));
}

interface DeploymentJob {
  id: string;
  projectId: string;
  branch: string | null;
  triggeredById: string | null;
  rollbackFromDeploymentId: string | null; // For quick rollback
  serverId: string | null; // Server ID for concurrency tracking
}

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
  logger.info('🚀 Deployment worker started');

  // Start polling for new deployments
  pollForDeployments();
}

/**
 * Stop the deployment worker
 */
export function stopDeploymentWorker(): void {
  isRunning = false;
  logger.info('Deployment worker stopped');
}

/**
 * Poll for pending deployments
 */
async function pollForDeployments(): Promise<void> {
  while (isRunning) {
    try {
      if (activeDeployments >= env.MAX_CONCURRENT_DEPLOYS_TOTAL) {
        // Global limit reached, skip this cycle
        logger.debug(
          { activeDeployments, limit: env.MAX_CONCURRENT_DEPLOYS_TOTAL },
          'Global deployment concurrency limit reached, waiting...'
        );
      } else {
        const job = await getNextEligibleDeployment();
        if (job) {
          const serverId = job.serverId || '__local__';
          activeDeployments++;
          incrementServerDeploys(serverId);
          logger.info(
            { deploymentId: job.id, serverId, activeDeployments, serverActive: activeDeploymentsPerServer.get(serverId) },
            'Deployment slot acquired'
          );

          processDeployment(job).finally(() => {
            activeDeployments--;
            decrementServerDeploys(serverId);
            logger.info(
              { deploymentId: job.id, serverId, activeDeployments, serverActive: activeDeploymentsPerServer.get(serverId) },
              'Deployment slot released'
            );
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
    .select({
      id: deployments.id,
      projectId: deployments.projectId,
      branch: deployments.branch,
      triggeredById: deployments.triggeredById,
      rollbackFromDeploymentId: deployments.rollbackFromDeploymentId,
      serverId: projects.serverId,
    })
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
    .select({
      id: deployments.id,
      projectId: deployments.projectId,
      branch: deployments.branch,
      triggeredById: deployments.triggeredById,
      rollbackFromDeploymentId: deployments.rollbackFromDeploymentId,
      serverId: projects.serverId,
    })
    .from(deployments)
    .innerJoin(projects, eq(deployments.projectId, projects.id))
    .where(eq(deployments.status, 'pending'))
    .orderBy(deployments.createdAt)
    .limit(10); // Fetch a batch to find an eligible one

  for (const job of pending) {
    const serverId = job.serverId || '__local__';

    if (canDeployToServerSlot(serverId)) {
      return job;
    }

    logger.debug(
      { deploymentId: job.id, serverId, serverActive: activeDeploymentsPerServer.get(serverId) },
      'Server concurrency limit reached, skipping deployment this cycle'
    );
  }

  return null;
}

/**
 * Process a deployment
 */
async function processDeployment(job: DeploymentJob): Promise<void> {
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

    // Check if project is active
    if (project.status !== 'active') {
      throw new Error('Project is not active');
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

    if (project.gitRepoUrl?.includes('github.com') && job.triggeredById) {
      // Get the GitHub integration for the user who triggered the deployment
      const integration = await db.query.gitIntegrations.findFirst({
        where: and(
          eq(gitIntegrations.userId, job.triggeredById),
          eq(gitIntegrations.provider, 'github')
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

      // Get commit hash from remote clone
      // First we need to clone locally to get the commit hash for status updates
      // Priority: job.branch (from webhook/manual) > project.gitBranch (user setting) > git default
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
      const localClone = await cloneRepository({
        repoUrl: project.gitRepoUrl,
        branch,
        accessToken,
        onProgress: addLog,
      });
      workDir = localClone.workDir;

      // Update commit info
      await db
        .update(deployments)
        .set({
          commitHash: localClone.commitHash,
          commitMessage: localClone.commitMessage,
          buildLogs: logBuffer.join('\n'),
        })
        .where(eq(deployments.id, job.id));

      // Set up GitHub status context
      if (prStatusChecksEnabled && accessToken && project.gitRepoUrl) {
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

      const remoteResult = await deployToRemoteServer({
        serverId: project.serverId,
        projectId: project.id,
        projectSlug: project.slug,
        deploymentId: job.id, // For image tagging (quick rollback support)
        repoUrl: project.gitRepoUrl,
        branch: localClone.branch,
        commitHash: localClone.commitHash,
        port: project.port || 3000,
        envVars: envVarsDecrypted,
        buildCommand: project.buildCommand || undefined,
        startCommand: project.startCommand || undefined,
        installCommand: project.installCommand || (projectSettings?.installCommand as string) || 'npm install --legacy-peer-deps',
        rootDirectory: project.rootDirectory || '.',
        dockerfilePath: project.dockerfilePath || undefined,
        outputDirectory: (projectSettings?.outputDirectory as string) || undefined,
        framework: (projectSettings?.framework as string) || undefined,
        accessToken,
        onProgress: onRemoteProgress,
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

      // Update project with production URL
      await db
        .update(projects)
        .set({
          settings: {
            ...(project.settings as Record<string, unknown>),
            productionUrl: remoteResult.deploymentUrl,
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

      addLog(`✅ Remote deployment successful! URL: ${remoteResult.deploymentUrl}`);
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
      await notificationService.sendNotifications(job.projectId, 'deployment.success', {
        deploymentId: job.id,
        branch: localClone.branch,
        commitHash: localClone.commitHash,
        status: 'running',
        message: 'Deployment completed successfully',
        url: remoteResult.deploymentUrl,
      });

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
      // Auto-detect framework if not set
      let framework = (project.settings as Record<string, string>)?.framework || null;

      if (!framework) {
        addLog('🔍 Auto-detecting framework...');
        framework = await detectFramework(workDir, project.rootDirectory || '.');
        if (framework) {
          addLog(`✅ Detected framework: ${framework}`);
        } else {
          addLog('⚠️ Could not detect framework, using generic Node.js');
          framework = 'nodejs';
        }
      }

      addLog('📄 Generating Dockerfile...');
      const dockerfileContent = generateDockerfile({
        framework,
        buildCommand: project.buildCommand,
        installCommand: project.installCommand || (project.settings as Record<string, string>)?.installCommand || 'npm install --legacy-peer-deps',
        startCommand: project.startCommand,
        outputDirectory: (project.settings as Record<string, string>)?.outputDirectory || null,
        port: project.port || 3000,
        rootDirectory: project.rootDirectory || '.',
        envVars: envVarsDecrypted,
      });
      await writeDockerfile(workDir, dockerfileContent);
      addLog('✅ Dockerfile generated');
    } else {
      addLog('✅ Using existing Dockerfile');
    }

    // Build Docker image
    const imageName = `pushify/${project.slug}`;
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

    // Update status to deploying
    await updateDeploymentStatus(job.id, 'deploying', logBuffer.join('\n'), job.projectId);
    addLog('🚀 Status: Deploying');

    // Run container (envVarsDecrypted already loaded above)
    const containerName = `pushify-${project.slug}`;

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
    let deploymentUrl = `http://localhost:${hostPort}`;
    try {
      const { domainService } = await import('../services/domain.service');
      const { domains: domainsTable } = await import('../db/schema/projects');
      const existingDomain = await db.query.domains.findFirst({
        where: eq(domainsTable.projectId, job.projectId),
        orderBy: (domains, { desc }) => [desc(domains.isPrimary)],
      });

      if (existingDomain) {
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

    // Update project with production URL
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

    // Publish running status via WebSocket
    wsManager.publish(`project:${job.projectId}`, {
      type: 'deployment:status',
      data: { projectId: job.projectId, deploymentId: job.id, status: 'running' },
    }).catch(() => {});

    addLog(`✅ Deployment successful! URL: ${deploymentUrl}`);
    logger.info(`Deployment ${job.id} completed successfully`);

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
    await notificationService.sendNotifications(job.projectId, 'deployment.success', {
      deploymentId: job.id,
      branch: cloneResult.branch,
      commitHash: cloneResult.commitHash,
      status: 'running',
      message: 'Deployment completed successfully',
      url: deploymentUrl,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    addLog(`❌ Deployment failed: ${errorMessage}`);

    // Get project for organizationId
    const failedProject = await db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, job.projectId))
      .limit(1)
      .then((r) => r[0]);

    await db
      .update(deployments)
      .set({
        status: 'failed',
        errorMessage,
        buildLogs: logBuffer.join('\n'),
      })
      .where(eq(deployments.id, job.id));

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

    // Send deployment failed notification
    await notificationService.sendNotifications(job.projectId, 'deployment.failed', {
      deploymentId: job.id,
      branch: job.branch || undefined,
      status: 'failed',
      message: errorMessage,
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
  return activeDeployments;
}
