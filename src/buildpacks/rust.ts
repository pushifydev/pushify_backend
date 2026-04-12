import { promises as fs } from 'fs';
import path from 'path';
import type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';

export const rustBuildpack: Buildpack = {
  id: 'rust',
  name: 'Rust',
  frameworks: ['actix', 'axum', 'rocket', 'rust'],

  async detect(workDir: string, rootDir: string): Promise<BuildpackDetectResult> {
    const base = path.join(workDir, rootDir === '.' ? '' : rootDir);
    try {
      const cargo = await fs.readFile(path.join(base, 'Cargo.toml'), 'utf-8').catch(() => '');
      if (!cargo) return { detected: false, framework: '', confidence: 0 };

      if (cargo.includes('actix-web')) return { detected: true, framework: 'actix', confidence: 95 };
      if (cargo.includes('axum')) return { detected: true, framework: 'axum', confidence: 95 };
      if (cargo.includes('rocket')) return { detected: true, framework: 'rocket', confidence: 95 };
      return { detected: true, framework: 'rust', confidence: 85 };
    } catch {
      return { detected: false, framework: '', confidence: 0 };
    }
  },

  generateDockerfile(config: BuildpackConfig): string {
    const port = config.port || 8080;
    const rootDir = config.rootDirectory || '.';
    const copyPrefix = rootDir === '.' ? '' : rootDir + '/';

    return `FROM rust:1.77-slim AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \\
    pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ${copyPrefix}Cargo.toml ${copyPrefix}Cargo.lock* ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src

COPY ${rootDir === '.' ? '.' : rootDir} .
RUN cargo build --release

FROM debian:bookworm-slim AS runner

RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/target/release/$(grep '^name' /app/Cargo.toml | head -1 | sed 's/.*= "//;s/"//' | tr '-' '_') /server 2>/dev/null || \\
    COPY --from=builder /app/target/release/* /server

EXPOSE ${port}
ENV PORT=${port}

CMD ["/server"]
`;
  },

  getDefaultPort(): number { return 8080; },
  getDefaultBuildCommand(): string { return 'cargo build --release'; },
  getDefaultStartCommand(): string { return './target/release/server'; },
  getDefaultInstallCommand(): string { return 'cargo fetch'; },
  getHealthCheckPath(): string { return '/health'; },
};
