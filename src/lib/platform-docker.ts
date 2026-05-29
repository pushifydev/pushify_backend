import { env } from '../config/env';

/**
 * Pushify platform Docker defaults — glibc Linux targets to avoid musl/gnu native module mismatches.
 */

export const DOCKERFILE_SYNTAX = '# syntax=docker/dockerfile:1.4\n';

/** Node.js build & run: Debian slim (glibc), not Alpine (musl). */
export const NODE_BUILD_IMAGE = 'node:20-bookworm-slim';
export const NODE_RUN_IMAGE = 'node:20-bookworm-slim';

export function nodeRunnerUserLines(): string {
  return `RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nextjs`;
}

/** Install deps without lifecycle scripts, then postinstall + optional native rebuild. */
export function nodeInstallLines(installCommand: string): string {
  return `RUN --mount=type=cache,target=/root/.npm \\
    ${installCommand} --ignore-scripts
COPY . .
RUN npm run postinstall --if-present
RUN npm rebuild 2>/dev/null || true`;
}

/** Best-effort: optional lightningcss gnu binding on glibc builders. */
export function nodeLightningcssGlibcFixLines(): string {
  return `RUN if [ -d node_modules/lightningcss ]; then \\
  LC_VER=$(node -p "require('lightningcss/package.json').version" 2>/dev/null || echo "1.30.2"); \\
  npm install --no-save --no-audit --no-fund "lightningcss-linux-x64-gnu@\${LC_VER}" 2>/dev/null || true; \\
  fi`;
}

export function getBuildMemoryLimit(framework?: string, buildpackId?: string): string {
  const heavyNode =
    buildpackId === 'nodejs' &&
    (framework === 'nextjs' ||
      framework === 'nuxt' ||
      framework === 'remix' ||
      framework === 'react' ||
      framework === 'vue' ||
      framework === 'svelte' ||
      framework === 'astro');
  if (heavyNode) return '2g';
  if (buildpackId === 'java' || buildpackId === 'rust') return '2g';
  if (buildpackId === 'python') return '1536m';
  return env.DOCKER_BUILD_MEMORY_LIMIT;
}

export function getRunMemoryLimit(framework?: string, buildpackId?: string): string {
  if (buildpackId === 'nodejs' && (framework === 'nextjs' || framework === 'nuxt' || framework === 'remix')) {
    return '768m';
  }
  if (buildpackId === 'java') return '768m';
  return env.DOCKER_MEMORY_LIMIT;
}

/** Prefix for remote/local docker build (BuildKit layer + mount caches). */
export function dockerBuildKitPrefix(): string {
  return 'DOCKER_BUILDKIT=1';
}

export function pipInstallRun(command: string): string {
  return `RUN --mount=type=cache,target=/root/.cache/pip \\
    ${command}`;
}

export function goModDownloadRun(): string {
  return `RUN --mount=type=cache,target=/go/pkg/mod \\
    go mod download`;
}

export function mavenDepsRun(): string {
  return `RUN --mount=type=cache,target=/root/.m2 \\
    mvn dependency:resolve -q`;
}

export function gradleDepsRun(): string {
  return `RUN --mount=type=cache,target=/home/gradle/.gradle \\
    gradle dependencies --no-daemon -q 2>/dev/null || true`;
}

export function cargoFetchRun(): string {
  return `RUN --mount=type=cache,target=/usr/local/cargo/registry \\
    --mount=type=cache,target=/app/target \\
    cargo build --release`;
}

/** Next.js runner when next.config has output: 'standalone'. */
export function nextStandaloneRunnerLines(workdir: string, port: number): string {
  return `
FROM ${NODE_RUN_IMAGE} AS runner
WORKDIR ${workdir}
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
${nodeRunnerUserLines()}
COPY --from=builder ${workdir}/public ./public
COPY --from=builder ${workdir}/.next/standalone ./
COPY --from=builder ${workdir}/.next/static ./.next/static
USER nextjs
EXPOSE ${port}
ENV PORT=${port}
ENV HOSTNAME="0.0.0.0"
CMD ["node", "server.js"]
`;
}
