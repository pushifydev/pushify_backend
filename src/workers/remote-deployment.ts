import { eq } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { domains } from '../db/schema/projects';
import { SSHClient } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { buildImage, runContainer, checkDocker, getImageId, tagImage, cleanupOldImages, runContainerFromImage, imageExists, blueGreenDeploy, completeBlueGreenSwitch } from './remote-docker';
import { addSite, reloadNginx, requestSSLCertificate } from './nginx-manager';
import { getOrAssignPort } from './port-manager';
import { generateDockerfile } from './dockerfile';
import path from 'path';

export interface RemoteDeploymentConfig {
  serverId: string;
  projectId: string;
  projectSlug: string;
  deploymentId: string; // For image tagging
  repoUrl: string;
  branch: string;
  commitHash: string;
  port: number;
  envVars: Record<string, string>;
  buildCommand?: string;
  startCommand?: string;
  installCommand?: string;
  rootDirectory?: string;
  dockerfilePath?: string;
  outputDirectory?: string;
  framework?: string;
  accessToken?: string;
  onProgress: (message: string) => void;
}

export interface RemoteDeploymentResult {
  success: boolean;
  deploymentUrl?: string;
  containerPort?: number;
  dockerImageId?: string; // Docker image ID for rollback
  error?: string;
}

/**
 * Get server details and establish SSH connection
 */
async function getServerAndConnect(serverId: string): Promise<{
  server: typeof servers.$inferSelect;
  ssh: SSHClient;
}> {
  // Get server from database
  const server = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });

  if (!server) {
    throw new Error('Server not found');
  }

  if (server.status !== 'running') {
    throw new Error(`Server is not running (status: ${server.status})`);
  }

  if (server.setupStatus !== 'completed') {
    throw new Error(`Server setup is not completed (status: ${server.setupStatus})`);
  }

  if (!server.ipv4) {
    throw new Error('Server has no IP address');
  }

  if (!server.sshPrivateKey) {
    throw new Error('Server has no SSH private key configured');
  }

  // Decrypt SSH private key
  const privateKey = decrypt(server.sshPrivateKey);

  // Create SSH connection
  const ssh = new SSHClient();
  await ssh.connect({
    host: server.ipv4,
    port: 22,
    username: 'root',
    privateKey,
  });

  return { server, ssh };
}

/**
 * Get primary domain for a project
 */
async function getPrimaryDomain(projectId: string): Promise<string | null> {
  const domain = await db.query.domains.findFirst({
    where: eq(domains.projectId, projectId),
    orderBy: (domains, { desc }) => [desc(domains.isPrimary)],
  });

  return domain?.domain || null;
}

/**
 * Deploy a project to a remote server
 */
export async function deployToRemoteServer(
  config: RemoteDeploymentConfig
): Promise<RemoteDeploymentResult> {
  const {
    serverId,
    projectId,
    projectSlug,
    deploymentId,
    repoUrl,
    branch,
    commitHash,
    port: configPort,
    envVars,
    buildCommand,
    startCommand,
    installCommand = 'npm install',
    rootDirectory = '.',
    dockerfilePath,
    outputDirectory,
    framework = 'nodejs',
    accessToken,
    onProgress,
  } = config;

  // Determine container port: prefer PORT from env vars, then config port, then default 3000
  const envPort = envVars?.PORT ? parseInt(envVars.PORT, 10) : null;
  const containerPort = envPort || configPort || 3000;
  onProgress(`📌 Container port: ${containerPort}${envPort ? ' (from env PORT)' : configPort ? ' (from project config)' : ' (default)'}`);

  // Add PORT to envVars if not set, so the app knows which port to listen on
  if (!envVars?.PORT) {
    envVars.PORT = String(containerPort);
  }

  let ssh: SSHClient | null = null;

  try {
    // Connect to server
    onProgress('🔌 Connecting to deployment server...');
    const { server, ssh: sshClient } = await getServerAndConnect(serverId);
    ssh = sshClient;

    // Verify Docker is available
    onProgress('🐳 Checking Docker availability...');
    const dockerStatus = await checkDocker(ssh);
    if (!dockerStatus.available) {
      throw new Error(`Docker is not available on server: ${dockerStatus.error}`);
    }
    onProgress(`✅ Docker ${dockerStatus.version} is available`);

    // Create project directory
    const projectDir = `/opt/pushify/apps/${projectSlug}`;
    const repoDir = `${projectDir}/repo`;

    onProgress(`📁 Creating project directory: ${projectDir}`);
    await ssh.exec(`rm -rf ${repoDir}`);
    await ssh.exec(`mkdir -p ${projectDir}`);

    // Clone repository
    onProgress(`📥 Cloning repository: ${repoUrl}`);

    // Build clone URL with token if available
    let cloneUrl = repoUrl;
    if (accessToken && repoUrl.includes('github.com')) {
      cloneUrl = repoUrl.replace('https://', `https://${accessToken}@`);
    }

    const cloneCmd = branch
      ? `git clone --depth 1 --branch ${branch} "${cloneUrl}" "${repoDir}"`
      : `git clone --depth 1 "${cloneUrl}" "${repoDir}"`;

    const cloneResult = await ssh.exec(cloneCmd);
    if (cloneResult.code !== 0) {
      throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
    }
    onProgress('✅ Repository cloned');

    // Check if Dockerfile exists
    const workDir = rootDirectory === '.' ? repoDir : path.posix.join(repoDir, rootDirectory);
    const dockerfileCheckPath = dockerfilePath
      ? path.posix.join(repoDir, dockerfilePath)
      : path.posix.join(workDir, 'Dockerfile');

    const hasDockerfile = await ssh.fileExists(dockerfileCheckPath);

    if (!hasDockerfile) {
      // Generate Dockerfile
      onProgress('📄 Generating Dockerfile...');
      const dockerfileContent = generateDockerfile({
        framework,
        buildCommand,
        installCommand,
        startCommand,
        outputDirectory,
        port: containerPort,
        rootDirectory,
      });

      await ssh.uploadFile(dockerfileContent, path.posix.join(workDir, 'Dockerfile'));
      onProgress('✅ Dockerfile generated');
    } else {
      onProgress('✅ Using existing Dockerfile');
    }

    // Build Docker image
    const imageName = `pushify-${projectSlug}`;
    const imageTag = commitHash.substring(0, 7);

    onProgress(`🔨 Building Docker image: ${imageName}:${imageTag}`);

    const buildResult = await buildImage(ssh, {
      workDir,
      imageName,
      tag: imageTag,
      dockerfilePath: dockerfilePath ? path.posix.join(repoDir, dockerfilePath) : undefined,
      onProgress,
    });

    if (!buildResult.success) {
      throw new Error(`Docker build failed:\n${buildResult.logs}`);
    }
    onProgress('✅ Docker image built successfully');

    // Get the Docker image ID for rollback support
    let dockerImageId: string | null = null;
    try {
      dockerImageId = await getImageId(ssh, imageName, imageTag);
      if (dockerImageId) {
        onProgress(`📋 Image ID: ${dockerImageId.substring(0, 12)}`);

        // Tag with deployment ID for preservation (allows quick rollback)
        const deploymentTag = `deploy-${deploymentId.substring(0, 8)}`;
        await tagImage(ssh, `${imageName}:${imageTag}`, `${imageName}:${deploymentTag}`);
        onProgress(`🏷️ Tagged image: ${imageName}:${deploymentTag}`);

        // Also tag as latest
        await tagImage(ssh, `${imageName}:${imageTag}`, `${imageName}:latest`);
        onProgress(`🏷️ Tagged image: ${imageName}:latest`);

        // Cleanup old images (keep last 5)
        const cleanupResult = await cleanupOldImages(ssh, imageName, 5);
        if (cleanupResult.removedCount > 0) {
          onProgress(`🧹 Cleaned up ${cleanupResult.removedCount} old image(s)`);
        }
      }
    } catch (tagError) {
      // Non-fatal error - image is still built
      onProgress(`⚠️ Image tagging warning: ${tagError instanceof Error ? tagError.message : 'Unknown error'}`);
    }

    // Determine host port: if user specified PORT in env, use that; otherwise use port-manager
    let hostPort: number;
    let portSource: string;

    if (envPort) {
      // User specified PORT in env - use it for both host and container
      hostPort = envPort;
      portSource = 'from env PORT';
      onProgress(`🔍 Using user-specified port: ${hostPort} (from env PORT)`);
    } else {
      // No PORT specified - assign dynamically
      onProgress('🔍 Assigning port...');
      const { port: assignedPort, isNew } = await getOrAssignPort(ssh, projectSlug);
      hostPort = assignedPort;
      portSource = isNew ? 'newly assigned' : 'existing';
      onProgress(`✅ Port assigned: ${hostPort} (${portSource})`);
    }

    // Use blue-green deployment for zero-downtime updates
    onProgress('🔵🟢 Starting blue-green deployment...');

    const blueGreenResult = await blueGreenDeploy(ssh, {
      imageName: `${imageName}:${imageTag}`,
      containerName: `pushify-${projectSlug}`,
      hostPort,
      containerPort,
      envVars,
      restart: 'unless-stopped',
      healthCheckTimeout: 60, // 60 seconds to become healthy
      onProgress,
    });

    if (!blueGreenResult.success) {
      throw new Error(`Blue-green deployment failed:\n${blueGreenResult.logs}`);
    }

    // Complete the blue-green switch (update ports and stop old container)
    onProgress('🔄 Switching traffic to new container...');
    const switchResult = await completeBlueGreenSwitch(ssh, {
      newContainerName: blueGreenResult.newContainerName!,
      oldContainerName: blueGreenResult.oldContainerName,
      targetPort: hostPort,
      containerPort,
      onProgress,
    });

    if (!switchResult.success) {
      throw new Error(`Blue-green switch failed: ${switchResult.message}`);
    }
    onProgress('✅ Zero-downtime deployment successful');

    // Open firewall port for external access
    onProgress(`🔓 Opening firewall port ${hostPort}...`);
    const firewallResult = await ssh.exec(`sudo ufw allow ${hostPort}/tcp && sudo ufw reload`);
    if (firewallResult.code === 0) {
      onProgress(`✅ Firewall port ${hostPort} opened and reloaded`);
    } else {
      // Try alternative approach - might already be open or UFW not active
      onProgress(`⚠️ UFW command result: ${firewallResult.stderr || firewallResult.stdout || 'unknown'}`);
      // Try iptables as fallback
      await ssh.exec(`sudo iptables -I INPUT -p tcp --dport ${hostPort} -j ACCEPT 2>/dev/null || true`);
      onProgress(`🔄 Tried iptables fallback for port ${hostPort}`);
    }

    // Get primary domain for this project
    const primaryDomain = await getPrimaryDomain(projectId);

    // Configure Nginx
    if (primaryDomain) {
      onProgress(`🌐 Configuring Nginx for domain: ${primaryDomain}`);

      const addResult = await addSite(ssh, {
        domain: primaryDomain,
        containerPort: hostPort,
        projectSlug,
        ssl: false, // Start without SSL, will be added after
      });

      if (!addResult.success) {
        onProgress(`⚠️ Nginx config warning: ${addResult.message}`);
      } else {
        onProgress('✅ Nginx site configured');

        // Reload Nginx
        const reloadResult = await reloadNginx(ssh);
        if (!reloadResult.success) {
          onProgress(`⚠️ Nginx reload warning: ${reloadResult.message}`);
        } else {
          onProgress('✅ Nginx reloaded');
        }

        // Try to get SSL certificate
        onProgress('🔐 Requesting SSL certificate...');
        try {
          const sslResult = await requestSSLCertificate(
            ssh,
            primaryDomain,
            'ssl@pushify.app' // TODO: Use org/user email
          );

          if (sslResult.success) {
            onProgress('✅ SSL certificate obtained');

            // Update Nginx config with SSL
            await addSite(ssh, {
              domain: primaryDomain,
              containerPort: hostPort,
              projectSlug,
              ssl: true,
            });
            await reloadNginx(ssh);
          } else {
            onProgress(`⚠️ SSL certificate failed: ${sslResult.message}`);
          }
        } catch (sslError) {
          onProgress(`⚠️ SSL certificate error: ${sslError instanceof Error ? sslError.message : 'Unknown error'}`);
        }
      }
    }

    // Determine deployment URL
    let deploymentUrl: string;
    if (primaryDomain) {
      deploymentUrl = `https://${primaryDomain}`;
    } else {
      deploymentUrl = `http://${server.ipv4}:${hostPort}`;
    }

    onProgress(`✅ Deployment successful! URL: ${deploymentUrl}`);

    return {
      success: true,
      deploymentUrl,
      containerPort: hostPort,
      dockerImageId: dockerImageId || undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    // Disconnect SSH
    if (ssh) {
      ssh.disconnect();
    }
  }
}

/**
 * Check if a project can be deployed to a remote server
 */
export async function canDeployToServer(serverId: string): Promise<{
  canDeploy: boolean;
  reason?: string;
}> {
  try {
    const server = await db.query.servers.findFirst({
      where: eq(servers.id, serverId),
    });

    if (!server) {
      return { canDeploy: false, reason: 'Server not found' };
    }

    if (server.status !== 'running') {
      return { canDeploy: false, reason: `Server is not running (status: ${server.status})` };
    }

    if (server.setupStatus !== 'completed') {
      return { canDeploy: false, reason: `Server setup is not completed (status: ${server.setupStatus})` };
    }

    if (!server.ipv4) {
      return { canDeploy: false, reason: 'Server has no IP address' };
    }

    if (!server.sshPrivateKey) {
      return { canDeploy: false, reason: 'Server has no SSH key configured' };
    }

    return { canDeploy: true };
  } catch (error) {
    return {
      canDeploy: false,
      reason: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Quick rollback configuration - uses existing Docker image
 */
export interface QuickRollbackConfig {
  serverId: string;
  projectId: string;
  projectSlug: string;
  targetDeploymentId: string; // The deployment to rollback to
  port: number;
  envVars: Record<string, string>;
  onProgress: (message: string) => void;
}

/**
 * Perform a quick rollback using an existing Docker image
 * No build required - just swap containers
 */
export async function quickRollbackToDeployment(
  config: QuickRollbackConfig
): Promise<RemoteDeploymentResult> {
  const {
    serverId,
    projectId,
    projectSlug,
    targetDeploymentId,
    port: configPort,
    envVars,
    onProgress,
  } = config;

  let ssh: SSHClient | null = null;

  try {
    // Connect to server
    onProgress('🔌 Connecting to deployment server...');
    const { server, ssh: sshClient } = await getServerAndConnect(serverId);
    ssh = sshClient;

    // Verify Docker is available
    onProgress('🐳 Checking Docker availability...');
    const dockerStatus = await checkDocker(ssh);
    if (!dockerStatus.available) {
      throw new Error(`Docker is not available on server: ${dockerStatus.error}`);
    }

    const imageName = `pushify-${projectSlug}`;
    const deploymentTag = `deploy-${targetDeploymentId.substring(0, 8)}`;
    const fullImageName = `${imageName}:${deploymentTag}`;

    // Check if the target image exists
    onProgress(`🔍 Checking for rollback image: ${fullImageName}`);
    const imgExists = await imageExists(ssh, imageName, deploymentTag);
    if (!imgExists) {
      throw new Error(`Rollback image not found: ${fullImageName}. The image may have been cleaned up.`);
    }
    onProgress('✅ Rollback image found');

    // Determine container port
    const envPort = envVars?.PORT ? parseInt(envVars.PORT, 10) : null;
    const containerPort = envPort || configPort || 3000;
    if (!envVars?.PORT) {
      envVars.PORT = String(containerPort);
    }

    // Get or assign host port
    let hostPort: number;
    if (envPort) {
      hostPort = envPort;
      onProgress(`🔍 Using user-specified port: ${hostPort}`);
    } else {
      const { port: assignedPort } = await getOrAssignPort(ssh, projectSlug);
      hostPort = assignedPort;
      onProgress(`🔍 Using assigned port: ${hostPort}`);
    }

    // Run container from existing image (this handles stopping the old container)
    onProgress(`🐳 Starting container from image: ${fullImageName}`);
    const runResult = await runContainerFromImage(ssh, {
      imageName: fullImageName,
      containerName: `pushify-${projectSlug}`,
      hostPort,
      containerPort,
      envVars,
      restart: 'unless-stopped',
      onProgress,
    });

    if (!runResult.success) {
      throw new Error(`Failed to start container:\n${runResult.logs}`);
    }
    onProgress('✅ Container started successfully');

    // Update latest tag to point to rollback image
    await tagImage(ssh, fullImageName, `${imageName}:latest`);
    onProgress(`🏷️ Updated latest tag to ${deploymentTag}`);

    // Get primary domain for URL
    const primaryDomain = await getPrimaryDomain(projectId);

    // Determine deployment URL
    let deploymentUrl: string;
    if (primaryDomain) {
      deploymentUrl = `https://${primaryDomain}`;
    } else {
      deploymentUrl = `http://${server.ipv4}:${hostPort}`;
    }

    onProgress(`✅ Rollback successful! URL: ${deploymentUrl}`);

    return {
      success: true,
      deploymentUrl,
      containerPort: hostPort,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    if (ssh) {
      ssh.disconnect();
    }
  }
}
