import { promises as fs } from 'fs';
import path from 'path';

export interface DockerfileOptions {
  framework?: string | null;
  buildCommand?: string | null;
  installCommand?: string | null;
  startCommand?: string | null;
  outputDirectory?: string | null;
  port?: number;
  rootDirectory?: string;
}

interface FrameworkConfig {
  baseImage: string;
  buildStage?: string;
  runCommand: string;
  exposedPort: number;
  staticSite?: boolean;
}

const FRAMEWORK_CONFIGS: Record<string, FrameworkConfig> = {
  nextjs: {
    baseImage: 'node:20-alpine',
    buildStage: 'builder',
    runCommand: 'node server.js',
    exposedPort: 3000,
  },
  react: {
    baseImage: 'node:20-alpine',
    buildStage: 'builder',
    runCommand: '',
    exposedPort: 80,
    staticSite: true,
  },
  vue: {
    baseImage: 'node:20-alpine',
    buildStage: 'builder',
    runCommand: '',
    exposedPort: 80,
    staticSite: true,
  },
  nuxt: {
    baseImage: 'node:20-alpine',
    buildStage: 'builder',
    runCommand: 'node .output/server/index.mjs',
    exposedPort: 3000,
  },
  svelte: {
    baseImage: 'node:20-alpine',
    buildStage: 'builder',
    runCommand: '',
    exposedPort: 80,
    staticSite: true,
  },
  astro: {
    baseImage: 'node:20-alpine',
    buildStage: 'builder',
    runCommand: '',
    exposedPort: 80,
    staticSite: true,
  },
  nodejs: {
    baseImage: 'node:20-alpine',
    runCommand: 'npm start',
    exposedPort: 3000,
  },
  static: {
    baseImage: 'nginx:alpine',
    runCommand: '',
    exposedPort: 80,
    staticSite: true,
  },
};

/**
 * Generate Dockerfile content based on framework
 */
export function generateDockerfile(options: DockerfileOptions): string {
  const {
    framework,
    buildCommand,
    installCommand,
    startCommand,
    outputDirectory,
    port = 3000,
    rootDirectory = '.',
  } = options;

  const config = framework ? FRAMEWORK_CONFIGS[framework] : FRAMEWORK_CONFIGS.nodejs;

  if (!config) {
    return generateGenericNodeDockerfile(options);
  }

  if (config.staticSite) {
    return generateStaticSiteDockerfile({
      buildCommand: buildCommand || 'npm run build',
      installCommand: installCommand || 'npm install',
      outputDirectory: outputDirectory || 'dist',
      rootDirectory,
    });
  }

  if (framework === 'nextjs') {
    return generateNextjsDockerfile({
      installCommand: installCommand || 'npm install',
      rootDirectory,
      port,
    });
  }

  if (framework === 'nuxt') {
    return generateNuxtDockerfile({
      installCommand: installCommand || 'npm install',
      rootDirectory,
      port,
    });
  }

  return generateGenericNodeDockerfile({
    buildCommand,
    installCommand: installCommand || 'npm install',
    startCommand: startCommand || 'npm start',
    port,
    rootDirectory,
  });
}

function generateNextjsDockerfile(options: {
  installCommand: string;
  rootDirectory: string;
  port: number;
}): string {
  const { installCommand, rootDirectory, port } = options;
  const workdir = rootDirectory === '.' || rootDirectory === './' ? '/app' : `/app/${rootDirectory}`;
  const copyPrefix = rootDirectory === '.' ? '' : rootDirectory + '/';

  return `# syntax=docker/dockerfile:1.4
# Next.js Dockerfile with BuildKit caching
FROM node:20-alpine AS builder

RUN apk add --no-cache libc6-compat
WORKDIR ${workdir}

# Copy package files
COPY ${copyPrefix}package*.json ./

# Install all dependencies with npm cache mount for faster builds
RUN --mount=type=cache,target=/root/.npm \\
    ${installCommand}

# Copy source code
COPY ${rootDirectory === '.' ? '.' : rootDirectory} .

# Build the application with next cache mount
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,target=${workdir}/.next/cache \\
    npm run build

# Production image
FROM node:20-alpine AS runner
WORKDIR ${workdir}

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy built application
COPY --from=builder ${workdir}/public ./public
COPY --from=builder ${workdir}/.next ./.next
COPY --from=builder ${workdir}/node_modules ./node_modules
COPY --from=builder ${workdir}/package.json ./package.json

USER nextjs

EXPOSE ${port}
ENV PORT=${port}
ENV HOSTNAME="0.0.0.0"

CMD ["npm", "start"]
`;
}

function generateNuxtDockerfile(options: {
  installCommand: string;
  rootDirectory: string;
  port: number;
}): string {
  const { installCommand, rootDirectory, port } = options;
  const workdir = rootDirectory === '.' || rootDirectory === './' ? '/app' : `/app/${rootDirectory}`;

  return `# syntax=docker/dockerfile:1.4
# Nuxt Dockerfile with BuildKit caching
FROM node:20-alpine AS builder
WORKDIR ${workdir}

COPY ${rootDirectory === '.' ? '' : rootDirectory + '/'}package*.json ./

# Install dependencies with npm cache mount
RUN --mount=type=cache,target=/root/.npm \\
    ${installCommand}

COPY ${rootDirectory === '.' ? '.' : rootDirectory} .

# Build with Nuxt cache mount
RUN --mount=type=cache,target=${workdir}/.nuxt \\
    npm run build

FROM node:20-alpine AS runner
WORKDIR ${workdir}

COPY --from=builder ${workdir}/.output ./.output

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=${port}

EXPOSE ${port}

CMD ["node", ".output/server/index.mjs"]
`;
}

function generateStaticSiteDockerfile(options: {
  buildCommand: string;
  installCommand: string;
  outputDirectory: string;
  rootDirectory: string;
}): string {
  const { buildCommand, installCommand, outputDirectory, rootDirectory } = options;
  const workdir = rootDirectory === '.' || rootDirectory === './' ? '/app' : `/app/${rootDirectory}`;

  return `# syntax=docker/dockerfile:1.4
# Static Site Dockerfile with BuildKit caching
FROM node:20-alpine AS builder
WORKDIR ${workdir}

COPY ${rootDirectory === '.' ? '' : rootDirectory + '/'}package*.json ./

# Install dependencies with npm cache mount
RUN --mount=type=cache,target=/root/.npm \\
    ${installCommand}

COPY ${rootDirectory === '.' ? '.' : rootDirectory} .
RUN ${buildCommand}

FROM nginx:alpine AS runner

COPY --from=builder ${workdir}/${outputDirectory} /usr/share/nginx/html

# Custom nginx config for SPA routing
RUN echo 'server { \\
    listen 80; \\
    location / { \\
        root /usr/share/nginx/html; \\
        index index.html; \\
        try_files $uri $uri/ /index.html; \\
    } \\
}' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
`;
}

function generateGenericNodeDockerfile(options: DockerfileOptions): string {
  const {
    buildCommand,
    installCommand = 'npm install',
    startCommand = 'npm start',
    port = 3000,
    rootDirectory = '.',
  } = options;

  const workdir = rootDirectory === '.' || rootDirectory === './' ? '/app' : `/app/${rootDirectory}`;

  let buildStep = '';
  if (buildCommand) {
    buildStep = `RUN ${buildCommand}\n`;
  }

  return `# syntax=docker/dockerfile:1.4
# Node.js Dockerfile with BuildKit caching
FROM node:20-alpine

WORKDIR ${workdir}

COPY ${rootDirectory === '.' ? '' : rootDirectory + '/'}package*.json ./

# Install dependencies with npm cache mount
RUN --mount=type=cache,target=/root/.npm \\
    ${installCommand}

COPY ${rootDirectory === '.' ? '.' : rootDirectory} .
${buildStep}
ENV NODE_ENV=production
ENV PORT=${port}

EXPOSE ${port}

CMD ${JSON.stringify((startCommand || 'npm start').split(' '))}
`;
}

/**
 * Check if Dockerfile exists in the repository
 */
export async function hasDockerfile(workDir: string, dockerfilePath?: string): Promise<boolean> {
  const checkPath = dockerfilePath || 'Dockerfile';
  try {
    await fs.access(path.join(workDir, checkPath));
    return true;
  } catch {
    return false;
  }
}

/**
 * Write Dockerfile to the repository
 */
export async function writeDockerfile(workDir: string, content: string): Promise<void> {
  await fs.writeFile(path.join(workDir, 'Dockerfile'), content, 'utf-8');
}
