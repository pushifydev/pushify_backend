import { promises as fs } from 'fs';
import path from 'path';
import type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';

export const staticBuildpack: Buildpack = {
  id: 'static',
  name: 'Static Site',
  frameworks: ['html', 'static'],

  async detect(workDir: string, rootDir: string): Promise<BuildpackDetectResult> {
    const base = path.join(workDir, rootDir === '.' ? '' : rootDir);
    try {
      const indexHtml = await fs.access(path.join(base, 'index.html')).then(() => true).catch(() => false);
      if (indexHtml) return { detected: true, framework: 'static', confidence: 50 };

      const publicIndex = await fs.access(path.join(base, 'public', 'index.html')).then(() => true).catch(() => false);
      if (publicIndex) return { detected: true, framework: 'static', confidence: 45 };

      return { detected: false, framework: '', confidence: 0 };
    } catch {
      return { detected: false, framework: '', confidence: 0 };
    }
  },

  generateDockerfile(config: BuildpackConfig): string {
    const rootDir = config.rootDirectory || '.';
    // The deploy workers map the host port to the project's configured port
    // (default 3000) — nginx must listen on that same port, not a hardcoded 80.
    const port = config.port || 80;

    return `FROM nginx:alpine

COPY ${rootDir === '.' ? '.' : rootDir} /usr/share/nginx/html

# A repo-root nginx.conf takes over the server config (it must listen on port ${port});
# it is moved out of the web root so it is never served. Otherwise use the SPA default.
RUN if [ -f /usr/share/nginx/html/nginx.conf ]; then mv /usr/share/nginx/html/nginx.conf /etc/nginx/conf.d/default.conf; else echo 'server { listen ${port}; location / { root /usr/share/nginx/html; try_files $uri $uri.html $uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf; fi

EXPOSE ${port}

CMD ["nginx", "-g", "daemon off;"]
`;
  },

  getDefaultPort(): number { return 80; },
  getDefaultBuildCommand(): string { return ''; },
  getDefaultStartCommand(): string { return 'nginx -g "daemon off;"'; },
  getDefaultInstallCommand(): string { return ''; },
  getHealthCheckPath(): string { return '/'; },
};
