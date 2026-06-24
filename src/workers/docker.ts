import { execStreamingCommand, execCommand, shSingleQuote, type StreamingCommandOptions } from './shell';
import { env } from '../config/env';
import net from 'net';

/**
 * Find an available port starting from a base port
 */
export async function findAvailablePort(startPort: number = 5000, maxAttempts: number = 100): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    const available = await isPortAvailable(port);
    if (available) {
      return port;
    }
  }
  throw new Error(`No available port found in range ${startPort}-${startPort + maxAttempts}`);
}

/**
 * Check if a port is available
 */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close();
      resolve(true);
    });

    server.listen(port, '0.0.0.0');
  });
}

export interface BuildOptions {
  workDir: string;
  imageName: string;
  tag?: string;
  dockerfilePath?: string;
  buildArgs?: Record<string, string>;
  onProgress?: (message: string) => void;
}

export interface RunOptions {
  imageName: string;
  containerName: string;
  hostPort: number;
  containerPort: number;
  envVars?: Record<string, string>;
  networkMode?: string;
  restart?: 'no' | 'always' | 'unless-stopped' | 'on-failure';
  onProgress?: (message: string) => void;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  port: number | null;
}

/**
 * Build a Docker image
 */
export async function buildImage(options: BuildOptions): Promise<void> {
  const { workDir, imageName, tag = 'latest', dockerfilePath, buildArgs, onProgress } = options;

  onProgress?.(`🔨 Building Docker image ${imageName}:${tag}...`);

  const args = [
    'build',
    '-t', `${imageName}:${tag}`,
    '--memory', env.DOCKER_BUILD_MEMORY_LIMIT,
  ];

  if (dockerfilePath) {
    args.push('-f', shSingleQuote(dockerfilePath));
  }

  if (buildArgs) {
    for (const [key, value] of Object.entries(buildArgs)) {
      // execStreamingCommand runs with shell:true, so quote user-controlled build args.
      args.push('--build-arg', shSingleQuote(`${key}=${value}`));
    }
  }

  args.push('.');

  const buildTimeoutMs = env.DOCKER_BUILD_TIMEOUT * 1000;

  const streamOptions: StreamingCommandOptions = {
    cwd: workDir,
    env: { DOCKER_BUILDKIT: '1' },
    onStdout: (data) => onProgress?.(data.trim()),
    onStderr: (data) => onProgress?.(data.trim()),
    timeout: buildTimeoutMs,
  };

  const result = await execStreamingCommand('docker', args, streamOptions);

  if (result.exitCode !== 0) {
    throw new Error(`Docker build failed: ${result.stderr}`);
  }

  onProgress?.(`✅ Image ${imageName}:${tag} built successfully`);
}

/**
 * Run a Docker container
 */
export async function runContainer(options: RunOptions): Promise<string> {
  const {
    imageName,
    containerName,
    hostPort,
    containerPort,
    envVars = {},
    networkMode,
    restart = 'unless-stopped',
    onProgress,
  } = options;

  onProgress?.(`🚀 Starting container ${containerName}...`);

  // Stop and remove existing container if exists
  await stopContainer(containerName).catch(() => {});
  await removeContainer(containerName).catch(() => {});

  const args = [
    'run',
    '-d',
    '--name', containerName,
    '-p', `${hostPort}:${containerPort}`,
    '--restart', restart,
    '--memory', env.DOCKER_MEMORY_LIMIT,
    '--memory-swap', '1g',
    '--cpus', env.DOCKER_CPU_LIMIT,
    '--pids-limit', '256',
  ];

  if (networkMode) {
    args.push('--network', shSingleQuote(networkMode));
  }

  // Single-quote NAME=value so a user env value cannot inject shell commands
  // (execCommand runs the joined args via /bin/sh -c).
  for (const [key, value] of Object.entries(envVars)) {
    args.push('-e', shSingleQuote(`${key}=${value}`));
  }

  args.push(imageName);

  const result = await execCommand(`docker ${args.join(' ')}`);

  if (result.exitCode !== 0) {
    throw new Error(`Failed to start container: ${result.stderr}`);
  }

  const containerId = result.stdout.trim();
  onProgress?.(`✅ Container started: ${containerId.substring(0, 12)}`);

  return containerId;
}

/**
 * Stop a running container
 */
export async function stopContainer(containerName: string): Promise<void> {
  await execCommand(`docker stop ${containerName}`, { timeout: 30000 });
}

/**
 * Remove a container
 */
export async function removeContainer(containerName: string): Promise<void> {
  await execCommand(`docker rm -f ${containerName}`, { timeout: 30000 });
}

/**
 * Get container info
 */
export async function getContainerInfo(containerName: string): Promise<ContainerInfo | null> {
  const result = await execCommand(
    `docker inspect --format='{{.Id}},{{.Name}},{{.State.Status}},{{range $p, $conf := .NetworkSettings.Ports}}{{$p}}{{end}}' ${containerName}`
  );

  if (result.exitCode !== 0) {
    return null;
  }

  const [id, name, status, portMapping] = result.stdout.trim().split(',');
  const portMatch = portMapping?.match(/(\d+)/);

  return {
    id: id?.substring(0, 12) || '',
    name: name?.replace('/', '') || '',
    status: status || 'unknown',
    port: portMatch ? parseInt(portMatch[1]) : null,
  };
}

/**
 * Check if container is running
 */
export async function isContainerRunning(containerName: string): Promise<boolean> {
  const result = await execCommand(
    `docker inspect --format='{{.State.Running}}' ${containerName}`
  );
  return result.stdout.trim() === 'true';
}

/**
 * Get container logs with options
 */
export async function getContainerLogs(
  containerName: string,
  options?: { tail?: number; since?: string }
): Promise<string> {
  const { tail = 100, since } = options || {};

  let cmd = `docker logs --tail ${tail}`;

  if (since) {
    cmd += ` --since ${since}`;
  }

  cmd += ` ${containerName} 2>&1`;

  const result = await execCommand(cmd);
  return result.stdout;
}

/**
 * Stream container logs in real-time
 */
export async function streamContainerLogs(
  containerName: string,
  onLog: (log: string) => void,
  options: { tail?: number; since?: string; signal?: AbortSignal } = {}
): Promise<void> {
  const { tail = 100, since, signal } = options;
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const args = ['logs', '-f'];
    if (since) {
      args.push('--since', since);
    } else {
      args.push('--tail', String(tail));
    }
    args.push(containerName);

    const proc = spawn('docker', args);

    let buffer = '';
    const flushChunk = (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split('\n');
      buffer = parts.pop() ?? '';
      for (const line of parts) {
        onLog(line);
      }
    };

    proc.stdout.on('data', (data: Buffer) => flushChunk(data.toString()));
    proc.stderr.on('data', (data: Buffer) => flushChunk(data.toString()));

    proc.on('error', (err) => {
      reject(err);
    });

    proc.on('close', (code) => {
      if (buffer) {
        onLog(buffer);
      }
      // 0 = normal end; 143 = SIGTERM when client disconnects
      if (code === 0 || code === 143 || signal?.aborted) {
        resolve();
      } else {
        reject(new Error(`Docker logs exited with code ${code}`));
      }
    });

    if (signal) {
      signal.addEventListener(
        'abort',
        () => {
          proc.kill('SIGTERM');
        },
        { once: true }
      );
    }
  });
}

/** Total size in bytes of a local Docker image (0 if missing). */
export async function getDockerImageSizeBytes(imageRef: string): Promise<number> {
  const result = await execCommand(
    `docker image inspect ${imageRef} --format '{{.Size}}'`,
    { timeout: 15000 },
  );
  if (result.exitCode !== 0) return 0;
  const parsed = parseInt(result.stdout.trim(), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Prune unused images
 */
export async function pruneImages(): Promise<void> {
  await execCommand('docker image prune -f', { timeout: 60000 });
}

/**
 * Remove an image
 */
export async function removeImage(imageName: string): Promise<void> {
  await execCommand(`docker rmi -f ${imageName}`, { timeout: 60000 });
}

/**
 * Check if Docker is available
 */
export async function isDockerAvailable(): Promise<boolean> {
  const result = await execCommand('docker info');
  return result.exitCode === 0;
}
