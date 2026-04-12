import { promises as fs } from 'fs';
import path from 'path';
import type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';

export const nodejsBuildpack: Buildpack = {
  id: 'nodejs',
  name: 'Node.js',
  frameworks: ['nextjs', 'nuxt', 'react', 'vue', 'svelte', 'astro', 'remix', 'express', 'fastify', 'hono', 'koa', 'nodejs'],

  async detect(workDir: string, rootDir: string): Promise<BuildpackDetectResult> {
    try {
      const pkgPath = path.join(workDir, rootDir === '.' ? '' : rootDir, 'package.json');
      const content = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(content);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      if (deps['next']) return { detected: true, framework: 'nextjs', confidence: 95 };
      if (deps['nuxt']) return { detected: true, framework: 'nuxt', confidence: 95 };
      if (deps['@sveltejs/kit'] || deps['svelte']) return { detected: true, framework: 'svelte', confidence: 90 };
      if (deps['astro']) return { detected: true, framework: 'astro', confidence: 90 };
      if (deps['@remix-run/react']) return { detected: true, framework: 'remix', confidence: 90 };
      if (deps['vue']) return { detected: true, framework: 'vue', confidence: 85 };
      if (deps['react'] || deps['react-dom']) return { detected: true, framework: 'react', confidence: 85 };
      if (deps['express']) return { detected: true, framework: 'express', confidence: 80 };
      if (deps['fastify']) return { detected: true, framework: 'fastify', confidence: 80 };
      if (deps['hono']) return { detected: true, framework: 'hono', confidence: 80 };
      if (deps['koa']) return { detected: true, framework: 'koa', confidence: 80 };

      return { detected: true, framework: 'nodejs', confidence: 70 };
    } catch {
      return { detected: false, framework: '', confidence: 0 };
    }
  },

  generateDockerfile(config: BuildpackConfig): string {
    const framework = (config as any).framework || 'nodejs';
    const port = config.port || this.getDefaultPort(framework);
    const install = config.installCommand || this.getDefaultInstallCommand(framework);
    const rootDir = config.rootDirectory || '.';
    const workdir = rootDir === '.' || rootDir === './' ? '/app' : `/app/${rootDir}`;
    const copyPrefix = rootDir === '.' ? '' : rootDir + '/';

    // Build env ARGs
    const envEntries = config.envVars ? Object.entries(config.envVars) : [];
    const argLines = envEntries.map(([k]) => `ARG ${k}`).join('\n');
    const envLines = envEntries.map(([k]) => `ENV ${k}=$${k}`).join('\n');
    const buildArgFlags = envEntries.map(([k, v]) => `--build-arg ${k}="${v}"`).join(' ');

    if (framework === 'nextjs') return this._nextjs(workdir, copyPrefix, rootDir, install, port, argLines, envLines);
    if (framework === 'nuxt') return this._nuxt(workdir, copyPrefix, rootDir, install, port, argLines, envLines);
    if (['react', 'vue', 'svelte', 'astro'].includes(framework)) {
      return this._static(workdir, copyPrefix, rootDir, install, config.buildCommand || 'npm run build', config.outputDirectory || 'dist');
    }
    return this._generic(workdir, copyPrefix, rootDir, install, config.buildCommand, config.startCommand || this.getDefaultStartCommand(framework), port);
  },

  getDefaultPort(framework?: string): number {
    if (framework === 'nextjs' || framework === 'nuxt' || framework === 'remix') return 3000;
    return 3000;
  },

  getDefaultBuildCommand(framework?: string): string {
    return 'npm run build';
  },

  getDefaultStartCommand(framework?: string): string {
    if (framework === 'nuxt') return 'node .output/server/index.mjs';
    return 'npm start';
  },

  getDefaultInstallCommand(): string {
    return 'npm install --legacy-peer-deps';
  },

  getHealthCheckPath(): string {
    return '/';
  },

  // ─── Private Dockerfile generators ───

  _nextjs(workdir: string, copyPrefix: string, rootDir: string, install: string, port: number, argLines: string, envLines: string): string {
    return `# syntax=docker/dockerfile:1.4
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR ${workdir}
COPY ${copyPrefix}package*.json ./
RUN --mount=type=cache,target=/root/.npm ${install}
COPY ${rootDir === '.' ? '.' : rootDir} .
${argLines}
${envLines}
ENV NEXT_TELEMETRY_DISABLED=1
RUN --mount=type=cache,target=${workdir}/.next/cache npm run build

FROM node:20-alpine AS runner
WORKDIR ${workdir}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs
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
  },

  _nuxt(workdir: string, copyPrefix: string, rootDir: string, install: string, port: number, argLines: string, envLines: string): string {
    return `# syntax=docker/dockerfile:1.4
FROM node:20-alpine AS builder
RUN apk add --no-cache libc6-compat
WORKDIR ${workdir}
COPY ${copyPrefix}package*.json ./
RUN --mount=type=cache,target=/root/.npm ${install}
COPY ${rootDir === '.' ? '.' : rootDir} .
${argLines}
${envLines}
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR ${workdir}
ENV NODE_ENV=production
COPY --from=builder ${workdir}/.output ./.output
EXPOSE ${port}
ENV PORT=${port}
ENV HOST="0.0.0.0"
CMD ["node", ".output/server/index.mjs"]
`;
  },

  _static(workdir: string, copyPrefix: string, rootDir: string, install: string, buildCmd: string, outDir: string): string {
    return `# syntax=docker/dockerfile:1.4
FROM node:20-alpine AS builder
WORKDIR ${workdir}
COPY ${copyPrefix}package*.json ./
RUN --mount=type=cache,target=/root/.npm ${install}
COPY ${rootDir === '.' ? '.' : rootDir} .
RUN ${buildCmd}

FROM nginx:alpine AS runner
COPY --from=builder ${workdir}/${outDir} /usr/share/nginx/html
RUN echo 'server { listen 80; location / { root /usr/share/nginx/html; try_files \\$uri \\$uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
`;
  },

  _generic(workdir: string, copyPrefix: string, rootDir: string, install: string, buildCmd: string | null | undefined, startCmd: string, port: number): string {
    const buildStep = buildCmd ? `RUN ${buildCmd}\n` : '';
    return `# syntax=docker/dockerfile:1.4
FROM node:20-alpine
RUN apk add --no-cache libc6-compat
WORKDIR ${workdir}
COPY ${copyPrefix}package*.json ./
RUN --mount=type=cache,target=/root/.npm ${install}
COPY ${rootDir === '.' ? '.' : rootDir} .
${buildStep}
EXPOSE ${port}
ENV PORT=${port}
ENV NODE_ENV=production
CMD ${JSON.stringify(startCmd.split(' '))}
`;
  },
} as Buildpack & Record<string, any>;
