import { promises as fs } from 'fs';
import path from 'path';
import type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';

export const goBuildpack: Buildpack = {
  id: 'go',
  name: 'Go',
  frameworks: ['gin', 'fiber', 'echo', 'chi', 'go'],

  async detect(workDir: string, rootDir: string): Promise<BuildpackDetectResult> {
    const base = path.join(workDir, rootDir === '.' ? '' : rootDir);
    try {
      const goMod = await fs.readFile(path.join(base, 'go.mod'), 'utf-8').catch(() => '');
      if (!goMod) return { detected: false, framework: '', confidence: 0 };

      if (goMod.includes('github.com/gin-gonic/gin')) return { detected: true, framework: 'gin', confidence: 95 };
      if (goMod.includes('github.com/gofiber/fiber')) return { detected: true, framework: 'fiber', confidence: 95 };
      if (goMod.includes('github.com/labstack/echo')) return { detected: true, framework: 'echo', confidence: 95 };
      if (goMod.includes('github.com/go-chi/chi')) return { detected: true, framework: 'chi', confidence: 95 };

      return { detected: true, framework: 'go', confidence: 85 };
    } catch {
      return { detected: false, framework: '', confidence: 0 };
    }
  },

  generateDockerfile(config: BuildpackConfig): string {
    const port = config.port || 8080;
    const rootDir = config.rootDirectory || '.';
    const workdir = rootDir === '.' || rootDir === './' ? '/app' : `/app/${rootDir}`;
    const copyPrefix = rootDir === '.' ? '' : rootDir + '/';

    return `FROM golang:1.22-alpine AS builder

RUN apk add --no-cache gcc musl-dev

WORKDIR ${workdir}

COPY ${copyPrefix}go.mod ${copyPrefix}go.sum* ./
RUN go mod download

COPY ${rootDir === '.' ? '.' : rootDir} .

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /server .

FROM alpine:3.19 AS runner

RUN apk add --no-cache ca-certificates tzdata

COPY --from=builder /server /server

EXPOSE ${port}
ENV PORT=${port}

CMD ["/server"]
`;
  },

  getDefaultPort(): number { return 8080; },
  getDefaultBuildCommand(): string { return 'go build -o server .'; },
  getDefaultStartCommand(): string { return './server'; },
  getDefaultInstallCommand(): string { return 'go mod download'; },
  getHealthCheckPath(): string { return '/health'; },
};
