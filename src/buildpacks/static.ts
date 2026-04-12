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

    return `FROM nginx:alpine

COPY ${rootDir === '.' ? '.' : rootDir} /usr/share/nginx/html

RUN echo 'server { listen 80; location / { root /usr/share/nginx/html; try_files \\$uri \\$uri/ /index.html; } }' > /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
`;
  },

  getDefaultPort(): number { return 80; },
  getDefaultBuildCommand(): string { return ''; },
  getDefaultStartCommand(): string { return 'nginx -g "daemon off;"'; },
  getDefaultInstallCommand(): string { return ''; },
  getHealthCheckPath(): string { return '/'; },
};
