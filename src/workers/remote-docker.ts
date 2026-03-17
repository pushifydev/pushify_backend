import type { SSHClient } from '../utils/ssh';

export interface BuildImageOptions {
  workDir: string;
  imageName: string;
  tag: string;
  dockerfilePath?: string;
  buildArgs?: Record<string, string>;
  onProgress?: (message: string) => void;
}

export interface RunContainerOptions {
  imageName: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  envVars?: Record<string, string>;
  volumes?: string[];
  networkMode?: string;
  restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  onProgress?: (message: string) => void;
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  ports: string;
  createdAt: string;
}

/**
 * Build a Docker image on a remote server with BuildKit caching
 */
export async function buildImage(
  ssh: SSHClient,
  options: BuildImageOptions
): Promise<{ success: boolean; logs: string }> {
  const { workDir, imageName, tag, dockerfilePath, buildArgs, onProgress } = options;

  // Enable Docker BuildKit for better caching and performance
  // BuildKit provides:
  // - Parallelized layer builds
  // - Better cache management
  // - Inline cache export/import for cross-build caching
  let buildCmd = `cd "${workDir}" && DOCKER_BUILDKIT=1 docker build`;

  // Enable inline cache for faster subsequent builds
  buildCmd += ` --build-arg BUILDKIT_INLINE_CACHE=1`;

  // Use cache from previous builds of this image
  buildCmd += ` --cache-from ${imageName}:latest`;
  buildCmd += ` --cache-from ${imageName}:${tag}`;

  if (dockerfilePath) {
    buildCmd += ` -f "${dockerfilePath}"`;
  }

  if (buildArgs) {
    for (const [key, value] of Object.entries(buildArgs)) {
      buildCmd += ` --build-arg ${key}="${value}"`;
    }
  }

  buildCmd += ` -t ${imageName}:${tag} .`;

  onProgress?.(`Building Docker image with BuildKit: ${imageName}:${tag}`);
  onProgress?.('📦 Using layer caching for faster builds');

  let logs = '';

  const exitCode = await ssh.execStream(
    buildCmd,
    (stdout) => {
      logs += stdout;
      onProgress?.(stdout.trim());
    },
    (stderr) => {
      logs += stderr;
      onProgress?.(stderr.trim());
    }
  );

  return {
    success: exitCode === 0,
    logs,
  };
}

/**
 * Run a Docker container on a remote server
 */
export async function runContainer(
  ssh: SSHClient,
  options: RunContainerOptions
): Promise<{ success: boolean; containerId?: string; logs: string }> {
  const {
    imageName,
    containerName,
    hostPort,
    containerPort,
    envVars,
    volumes,
    networkMode,
    restart = 'unless-stopped',
    onProgress,
  } = options;

  // Stop and remove existing container with same name
  onProgress?.(`Stopping existing container: ${containerName}`);
  await ssh.exec(`docker stop ${containerName} 2>/dev/null || true`);
  await ssh.exec(`docker rm ${containerName} 2>/dev/null || true`);

  // Build the docker run command
  let runCmd = `docker run -d --name ${containerName}`;

  // Port mapping - bind to all interfaces for external access
  runCmd += ` -p 0.0.0.0:${hostPort}:${containerPort}`;

  // Environment variables
  if (envVars) {
    for (const [key, value] of Object.entries(envVars)) {
      // Escape special characters in value
      const escapedValue = value.replace(/"/g, '\\"');
      runCmd += ` -e "${key}=${escapedValue}"`;
    }
  }

  // Volumes
  if (volumes) {
    for (const volume of volumes) {
      runCmd += ` -v ${volume}`;
    }
  }

  // Network mode
  if (networkMode) {
    runCmd += ` --network ${networkMode}`;
  }

  // Restart policy
  runCmd += ` --restart ${restart}`;

  // Image
  runCmd += ` ${imageName}`;

  onProgress?.(`Starting container: ${containerName} on port ${hostPort}`);

  const result = await ssh.exec(runCmd);

  if (result.code !== 0) {
    return {
      success: false,
      logs: result.stderr || result.stdout,
    };
  }

  const containerId = result.stdout.trim();

  // Verify container is running
  await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for container to start

  const statusResult = await ssh.exec(`docker inspect -f '{{.State.Running}}' ${containerName}`);
  const isRunning = statusResult.stdout.trim() === 'true';

  if (!isRunning) {
    // Get logs to see why it failed
    const logsResult = await ssh.exec(`docker logs ${containerName} 2>&1 | tail -50`);
    return {
      success: false,
      containerId,
      logs: `Container failed to start:\n${logsResult.stdout}`,
    };
  }

  return {
    success: true,
    containerId,
    logs: `Container ${containerName} started successfully with ID: ${containerId}`,
  };
}

/**
 * Stop a running container
 */
export async function stopContainer(
  ssh: SSHClient,
  containerName: string
): Promise<{ success: boolean; message: string }> {
  const result = await ssh.exec(`docker stop ${containerName}`);

  return {
    success: result.code === 0,
    message: result.code === 0
      ? `Container ${containerName} stopped`
      : result.stderr || 'Failed to stop container',
  };
}

/**
 * Remove a container
 */
export async function removeContainer(
  ssh: SSHClient,
  containerName: string,
  force: boolean = false
): Promise<{ success: boolean; message: string }> {
  const cmd = force ? `docker rm -f ${containerName}` : `docker rm ${containerName}`;
  const result = await ssh.exec(cmd);

  return {
    success: result.code === 0,
    message: result.code === 0
      ? `Container ${containerName} removed`
      : result.stderr || 'Failed to remove container',
  };
}

/**
 * Get container logs
 */
export async function getContainerLogs(
  ssh: SSHClient,
  containerName: string,
  options?: { tail?: number; since?: string }
): Promise<string> {
  let cmd = `docker logs ${containerName} 2>&1`;

  if (options?.tail) {
    cmd = `docker logs --tail ${options.tail} ${containerName} 2>&1`;
  }

  if (options?.since) {
    cmd = `docker logs --since ${options.since} ${containerName} 2>&1`;
  }

  const result = await ssh.exec(cmd);
  return result.stdout || result.stderr;
}

/**
 * List all containers
 */
export async function listContainers(
  ssh: SSHClient,
  options?: { all?: boolean; filter?: string }
): Promise<ContainerInfo[]> {
  let cmd = 'docker ps --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}|{{.CreatedAt}}"';

  if (options?.all) {
    cmd = cmd.replace('docker ps', 'docker ps -a');
  }

  if (options?.filter) {
    cmd += ` --filter "${options.filter}"`;
  }

  const result = await ssh.exec(cmd);

  if (result.code !== 0 || !result.stdout.trim()) {
    return [];
  }

  return result.stdout.trim().split('\n').map((line) => {
    const [id, name, image, status, ports, createdAt] = line.split('|');
    return { id, name, image, status, ports, createdAt };
  });
}

/**
 * Check if a container exists
 */
export async function containerExists(
  ssh: SSHClient,
  containerName: string
): Promise<boolean> {
  const result = await ssh.exec(`docker inspect ${containerName} 2>/dev/null`);
  return result.code === 0;
}

/**
 * Check if a container is running
 */
export async function isContainerRunning(
  ssh: SSHClient,
  containerName: string
): Promise<boolean> {
  const result = await ssh.exec(`docker inspect -f '{{.State.Running}}' ${containerName} 2>/dev/null`);
  return result.stdout.trim() === 'true';
}

/**
 * Pull a Docker image
 */
export async function pullImage(
  ssh: SSHClient,
  imageName: string,
  onProgress?: (message: string) => void
): Promise<{ success: boolean; logs: string }> {
  let logs = '';

  const exitCode = await ssh.execStream(
    `docker pull ${imageName}`,
    (stdout) => {
      logs += stdout;
      onProgress?.(stdout.trim());
    },
    (stderr) => {
      logs += stderr;
      onProgress?.(stderr.trim());
    }
  );

  return {
    success: exitCode === 0,
    logs,
  };
}

/**
 * Remove a Docker image
 */
export async function removeImage(
  ssh: SSHClient,
  imageName: string,
  force: boolean = false
): Promise<{ success: boolean; message: string }> {
  const cmd = force ? `docker rmi -f ${imageName}` : `docker rmi ${imageName}`;
  const result = await ssh.exec(cmd);

  return {
    success: result.code === 0,
    message: result.code === 0
      ? `Image ${imageName} removed`
      : result.stderr || 'Failed to remove image',
  };
}

/**
 * Prune unused Docker resources
 */
export async function pruneDocker(
  ssh: SSHClient,
  options?: { images?: boolean; volumes?: boolean; all?: boolean }
): Promise<{ success: boolean; logs: string }> {
  const commands: string[] = [];

  if (options?.all) {
    commands.push('docker system prune -af');
  } else {
    commands.push('docker container prune -f');
    if (options?.images) {
      commands.push('docker image prune -af');
    }
    if (options?.volumes) {
      commands.push('docker volume prune -f');
    }
  }

  let logs = '';
  let success = true;

  for (const cmd of commands) {
    const result = await ssh.exec(cmd);
    logs += result.stdout + result.stderr + '\n';
    if (result.code !== 0) {
      success = false;
    }
  }

  return { success, logs };
}

/**
 * Check Docker version and availability
 */
export async function checkDocker(
  ssh: SSHClient
): Promise<{ available: boolean; version?: string; error?: string }> {
  const result = await ssh.exec('docker --version');

  if (result.code !== 0) {
    return {
      available: false,
      error: result.stderr || 'Docker not available',
    };
  }

  // Extract version from output like "Docker version 24.0.5, build ced0996"
  const versionMatch = result.stdout.match(/Docker version ([0-9.]+)/);

  return {
    available: true,
    version: versionMatch ? versionMatch[1] : result.stdout.trim(),
  };
}

/**
 * Get Docker image ID by name and tag
 */
export async function getImageId(
  ssh: SSHClient,
  imageName: string,
  tag: string
): Promise<string | null> {
  const result = await ssh.exec(`docker images -q ${imageName}:${tag}`);
  const imageId = result.stdout.trim();
  return imageId || null;
}

/**
 * Tag an existing image with additional tags (for versioning)
 */
export async function tagImage(
  ssh: SSHClient,
  sourceImage: string,
  targetImage: string
): Promise<{ success: boolean; message: string }> {
  const result = await ssh.exec(`docker tag ${sourceImage} ${targetImage}`);

  return {
    success: result.code === 0,
    message: result.code === 0
      ? `Tagged ${sourceImage} as ${targetImage}`
      : result.stderr || 'Failed to tag image',
  };
}

/**
 * List all images for a project (by name prefix)
 */
export async function listProjectImages(
  ssh: SSHClient,
  projectImageName: string
): Promise<Array<{ id: string; tag: string; createdAt: string; size: string }>> {
  // List images with format: ID, Tag, Created, Size
  const result = await ssh.exec(
    `docker images ${projectImageName} --format "{{.ID}}|{{.Tag}}|{{.CreatedAt}}|{{.Size}}" 2>/dev/null`
  );

  if (result.code !== 0 || !result.stdout.trim()) {
    return [];
  }

  return result.stdout.trim().split('\n').map((line) => {
    const [id, tag, createdAt, size] = line.split('|');
    return { id, tag, createdAt, size };
  });
}

/**
 * Keep only the last N images for a project, remove older ones
 * Preserves 'latest' tag always
 */
export async function cleanupOldImages(
  ssh: SSHClient,
  projectImageName: string,
  keepCount: number = 5
): Promise<{ removedCount: number; removedImages: string[] }> {
  const images = await listProjectImages(ssh, projectImageName);

  // Sort by createdAt (most recent first) and filter out 'latest'
  const sortedImages = images
    .filter(img => img.tag !== 'latest' && img.tag !== '<none>')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  // Keep the most recent N, remove the rest
  const toRemove = sortedImages.slice(keepCount);
  const removedImages: string[] = [];

  for (const img of toRemove) {
    const result = await ssh.exec(`docker rmi ${projectImageName}:${img.tag} 2>/dev/null || true`);
    if (result.code === 0) {
      removedImages.push(`${projectImageName}:${img.tag}`);
    }
  }

  return {
    removedCount: removedImages.length,
    removedImages,
  };
}

/**
 * Check if a specific image exists
 */
export async function imageExists(
  ssh: SSHClient,
  imageName: string,
  tag: string
): Promise<boolean> {
  const result = await ssh.exec(`docker image inspect ${imageName}:${tag} 2>/dev/null`);
  return result.code === 0;
}

/**
 * Run container from existing image (for quick rollback, no build needed)
 */
export async function runContainerFromImage(
  ssh: SSHClient,
  options: RunContainerOptions & { skipStopExisting?: boolean }
): Promise<{ success: boolean; containerId?: string; logs: string }> {
  const {
    imageName,
    containerName,
    hostPort,
    containerPort,
    envVars,
    volumes,
    networkMode,
    restart = 'unless-stopped',
    onProgress,
    skipStopExisting = false,
  } = options;

  if (!skipStopExisting) {
    // Stop and remove existing container with same name
    onProgress?.(`Stopping existing container: ${containerName}`);
    await ssh.exec(`docker stop ${containerName} 2>/dev/null || true`);
    await ssh.exec(`docker rm ${containerName} 2>/dev/null || true`);
  }

  // Build the docker run command
  let runCmd = `docker run -d --name ${containerName}`;

  // Port mapping
  runCmd += ` -p 0.0.0.0:${hostPort}:${containerPort}`;

  // Environment variables
  if (envVars) {
    for (const [key, value] of Object.entries(envVars)) {
      const escapedValue = value.replace(/"/g, '\\"');
      runCmd += ` -e "${key}=${escapedValue}"`;
    }
  }

  // Volumes
  if (volumes) {
    for (const volume of volumes) {
      runCmd += ` -v ${volume}`;
    }
  }

  // Network mode
  if (networkMode) {
    runCmd += ` --network ${networkMode}`;
  }

  // Restart policy
  runCmd += ` --restart ${restart}`;

  // Image
  runCmd += ` ${imageName}`;

  onProgress?.(`Starting container from image: ${imageName}`);

  const result = await ssh.exec(runCmd);

  if (result.code !== 0) {
    return {
      success: false,
      logs: result.stderr || result.stdout,
    };
  }

  const containerId = result.stdout.trim();

  // Verify container is running
  await new Promise((resolve) => setTimeout(resolve, 2000));

  const statusResult = await ssh.exec(`docker inspect -f '{{.State.Running}}' ${containerName}`);
  const isRunning = statusResult.stdout.trim() === 'true';

  if (!isRunning) {
    const logsResult = await ssh.exec(`docker logs ${containerName} 2>&1 | tail -50`);
    return {
      success: false,
      containerId,
      logs: `Container failed to start:\n${logsResult.stdout}`,
    };
  }

  return {
    success: true,
    containerId,
    logs: `Container ${containerName} started successfully`,
  };
}

/**
 * Blue-green deployment options
 */
export interface BlueGreenDeployOptions {
  imageName: string;
  containerName: string; // Base name (will use -blue/-green suffixes)
  hostPort: number;
  containerPort: number;
  envVars?: Record<string, string>;
  volumes?: string[];
  networkMode?: string;
  restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  healthCheckPath?: string; // Optional HTTP health check path (e.g., "/health")
  healthCheckTimeout?: number; // Timeout in seconds (default: 60)
  onProgress?: (message: string) => void;
}

/**
 * Perform blue-green deployment for zero-downtime updates
 * 1. Start new container alongside old one
 * 2. Wait for new container to be healthy
 * 3. Return the new container info (Nginx update is handled separately)
 * 4. Old container can be stopped after Nginx is updated
 */
export async function blueGreenDeploy(
  ssh: SSHClient,
  options: BlueGreenDeployOptions
): Promise<{
  success: boolean;
  newContainerName?: string;
  newContainerId?: string;
  oldContainerName?: string;
  logs: string;
}> {
  const {
    imageName,
    containerName,
    hostPort,
    containerPort,
    envVars,
    volumes,
    networkMode,
    restart = 'unless-stopped',
    healthCheckPath,
    healthCheckTimeout = 60,
    onProgress,
  } = options;

  // Determine current active slot (blue or green)
  const blueExists = (await ssh.exec(`docker inspect ${containerName}-blue 2>/dev/null`)).code === 0;
  const greenExists = (await ssh.exec(`docker inspect ${containerName}-green 2>/dev/null`)).code === 0;

  let activeSlot: 'blue' | 'green' | 'none' = 'none';
  let newSlot: 'blue' | 'green';

  if (blueExists && !greenExists) {
    activeSlot = 'blue';
    newSlot = 'green';
  } else if (greenExists && !blueExists) {
    activeSlot = 'green';
    newSlot = 'blue';
  } else if (blueExists && greenExists) {
    // Both exist, check which one is actually running
    const blueRunning = (await ssh.exec(`docker inspect -f '{{.State.Running}}' ${containerName}-blue 2>/dev/null`)).stdout.trim() === 'true';
    activeSlot = blueRunning ? 'blue' : 'green';
    newSlot = blueRunning ? 'green' : 'blue';
    // Remove the old inactive container
    await ssh.exec(`docker rm -f ${containerName}-${newSlot} 2>/dev/null || true`);
  } else {
    // Neither exists - check for legacy container without suffix
    const legacyExists = (await ssh.exec(`docker inspect ${containerName} 2>/dev/null`)).code === 0;
    if (legacyExists) {
      onProgress?.('🔄 Migrating from legacy single-container to blue-green...');
      // Rename legacy container to blue
      await ssh.exec(`docker rename ${containerName} ${containerName}-blue 2>/dev/null || true`);
      activeSlot = 'blue';
    }
    newSlot = 'green';
  }

  const newContainerName = `${containerName}-${newSlot}`;
  const oldContainerName = activeSlot !== 'none' ? `${containerName}-${activeSlot}` : undefined;

  onProgress?.(`📊 Active slot: ${activeSlot}, deploying to: ${newSlot}`);

  // Find a temporary port for the new container
  // We'll use a port in the high range that's different from the current
  const tempPortResult = await ssh.exec(`
    for port in $(seq 30000 30100); do
      if ! ss -tlnp | grep -q ":$port "; then
        echo $port
        break
      fi
    done
  `);
  const tempPort = parseInt(tempPortResult.stdout.trim()) || 30000;
  onProgress?.(`🔌 Using temporary port ${tempPort} for new container`);

  // Build the docker run command for new container
  let runCmd = `docker run -d --name ${newContainerName}`;

  // Port mapping - use temporary port initially
  runCmd += ` -p 0.0.0.0:${tempPort}:${containerPort}`;

  // Environment variables
  if (envVars) {
    for (const [key, value] of Object.entries(envVars)) {
      const escapedValue = value.replace(/"/g, '\\"');
      runCmd += ` -e "${key}=${escapedValue}"`;
    }
  }

  // Volumes
  if (volumes) {
    for (const volume of volumes) {
      runCmd += ` -v ${volume}`;
    }
  }

  // Network mode
  if (networkMode) {
    runCmd += ` --network ${networkMode}`;
  }

  // Restart policy
  runCmd += ` --restart ${restart}`;

  // Image
  runCmd += ` ${imageName}`;

  onProgress?.(`🐳 Starting new container: ${newContainerName}`);

  const result = await ssh.exec(runCmd);

  if (result.code !== 0) {
    return {
      success: false,
      logs: `Failed to start new container: ${result.stderr || result.stdout}`,
    };
  }

  const newContainerId = result.stdout.trim();
  onProgress?.(`✅ New container started: ${newContainerId.substring(0, 12)}`);

  // Wait for container to be healthy
  onProgress?.('⏳ Waiting for container to become healthy...');

  const startTime = Date.now();
  let isHealthy = false;

  while (Date.now() - startTime < healthCheckTimeout * 1000) {
    // Check if container is running
    const statusResult = await ssh.exec(`docker inspect -f '{{.State.Running}}' ${newContainerName}`);
    if (statusResult.stdout.trim() !== 'true') {
      const logsResult = await ssh.exec(`docker logs ${newContainerName} 2>&1 | tail -30`);
      // Cleanup failed container
      await ssh.exec(`docker rm -f ${newContainerName} 2>/dev/null || true`);
      return {
        success: false,
        logs: `Container exited unexpectedly:\n${logsResult.stdout}`,
      };
    }

    // If health check path is provided, do HTTP check
    if (healthCheckPath) {
      const healthResult = await ssh.exec(
        `curl -sf http://127.0.0.1:${tempPort}${healthCheckPath} -o /dev/null -w "%{http_code}" 2>/dev/null || echo "000"`
      );
      const statusCode = healthResult.stdout.trim();
      if (statusCode === '200' || statusCode === '204') {
        isHealthy = true;
        break;
      }
    } else {
      // No health check path - just check if container is accepting connections
      const tcpCheck = await ssh.exec(`nc -z 127.0.0.1 ${tempPort} 2>/dev/null && echo "OK" || echo "FAIL"`);
      if (tcpCheck.stdout.trim() === 'OK') {
        isHealthy = true;
        break;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    onProgress?.(`⏳ Health check in progress... (${elapsed}s)`);
  }

  if (!isHealthy) {
    const logsResult = await ssh.exec(`docker logs ${newContainerName} 2>&1 | tail -30`);
    // Cleanup unhealthy container
    await ssh.exec(`docker rm -f ${newContainerName} 2>/dev/null || true`);
    return {
      success: false,
      logs: `Container health check timeout:\n${logsResult.stdout}`,
    };
  }

  onProgress?.('✅ New container is healthy');

  // Now update port mapping - stop old container and reconfigure new one
  // The Nginx manager will handle the final port routing

  return {
    success: true,
    newContainerName,
    newContainerId,
    oldContainerName,
    logs: `Blue-green deployment ready. New container: ${newContainerName} (temp port: ${tempPort})`,
  };
}

/**
 * Complete the blue-green switch by updating ports and stopping old container
 */
export async function completeBlueGreenSwitch(
  ssh: SSHClient,
  options: {
    newContainerName: string;
    oldContainerName?: string;
    targetPort: number;
    containerPort: number;
    onProgress?: (message: string) => void;
  }
): Promise<{ success: boolean; message: string }> {
  const { newContainerName, oldContainerName, targetPort, containerPort, onProgress } = options;

  try {
    // Stop old container first (this frees up the port)
    if (oldContainerName) {
      onProgress?.(`🛑 Stopping old container: ${oldContainerName}`);
      await ssh.exec(`docker stop ${oldContainerName} 2>/dev/null || true`);
    }

    // Get current container info
    const inspectResult = await ssh.exec(`docker inspect ${newContainerName} 2>/dev/null`);
    if (inspectResult.code !== 0) {
      throw new Error(`New container not found: ${newContainerName}`);
    }

    // Stop new container, recreate with correct port
    onProgress?.('🔄 Reconfiguring new container with production port...');

    // Get container's image
    const imageResult = await ssh.exec(`docker inspect -f '{{.Config.Image}}' ${newContainerName}`);
    const imageName = imageResult.stdout.trim();

    // Get environment variables
    const envResult = await ssh.exec(`docker inspect -f '{{range .Config.Env}}{{.}}{{println}}{{end}}' ${newContainerName}`);
    const envLines = envResult.stdout.trim().split('\n').filter(line => line);

    // Stop and remove new container
    await ssh.exec(`docker stop ${newContainerName} 2>/dev/null || true`);
    await ssh.exec(`docker rm ${newContainerName} 2>/dev/null || true`);

    // Recreate with correct port
    let runCmd = `docker run -d --name ${newContainerName}`;
    runCmd += ` -p 0.0.0.0:${targetPort}:${containerPort}`;

    for (const envLine of envLines) {
      const escapedEnv = envLine.replace(/"/g, '\\"');
      runCmd += ` -e "${escapedEnv}"`;
    }

    runCmd += ` --restart unless-stopped`;
    runCmd += ` ${imageName}`;

    const restartResult = await ssh.exec(runCmd);
    if (restartResult.code !== 0) {
      throw new Error(`Failed to restart container: ${restartResult.stderr}`);
    }

    onProgress?.(`✅ New container running on port ${targetPort}`);

    // Remove old container
    if (oldContainerName) {
      onProgress?.(`🗑️ Removing old container: ${oldContainerName}`);
      await ssh.exec(`docker rm -f ${oldContainerName} 2>/dev/null || true`);
    }

    return {
      success: true,
      message: `Blue-green switch completed. Active: ${newContainerName}`,
    };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
