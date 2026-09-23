import { promises as fs } from 'fs';
import path from 'path';
import type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';
import { composerInstallRun } from '../lib/platform-docker';

type PhpCommands = { install?: string | null; build?: string | null; start?: string | null };

/** `CMD ["sh", "-c", …]` so a start command may use env vars, `&&` and pipes. */
const shCmd = (cmd: string): string => `CMD ["sh", "-c", ${JSON.stringify(cmd)}]`;

export const phpBuildpack: Buildpack = {
  id: 'php',
  name: 'PHP',
  frameworks: ['laravel', 'symfony', 'php'],

  async detect(workDir: string, rootDir: string): Promise<BuildpackDetectResult> {
    const base = path.join(workDir, rootDir === '.' ? '' : rootDir);
    try {
      const composer = await fs.readFile(path.join(base, 'composer.json'), 'utf-8').catch(() => '');
      if (!composer) {
        const indexPhp = await fs.access(path.join(base, 'index.php')).then(() => true).catch(() => false);
        if (indexPhp) return { detected: true, framework: 'php', confidence: 60 };
        return { detected: false, framework: '', confidence: 0 };
      }

      if (composer.includes('laravel/framework')) return { detected: true, framework: 'laravel', confidence: 95 };
      if (composer.includes('symfony/framework-bundle')) return { detected: true, framework: 'symfony', confidence: 95 };
      return { detected: true, framework: 'php', confidence: 80 };
    } catch {
      return { detected: false, framework: '', confidence: 0 };
    }
  },

  generateDockerfile(config: BuildpackConfig): string {
    const framework = (config as any).framework || 'php';
    const port = config.port || 8000;
    const rootDir = config.rootDirectory || '.';
    const copyPrefix = rootDir === '.' ? '' : rootDir + '/';

    // install / build / start from the dashboard or pushify.yaml win over the defaults.
    const cmds = { install: config.installCommand, build: config.buildCommand, start: config.startCommand };
    if (framework === 'laravel') return this._laravel(copyPrefix, rootDir, port, cmds);
    return this._generic(copyPrefix, rootDir, port, cmds);
  },

  getDefaultPort(): number { return 8000; },
  getDefaultBuildCommand(framework?: string): string {
    if (framework === 'laravel') return 'php artisan config:cache && php artisan route:cache';
    return '';
  },
  getDefaultStartCommand(framework?: string): string {
    if (framework === 'laravel') return 'php artisan serve --host=0.0.0.0 --port=8000';
    return 'php -S 0.0.0.0:8000 -t public';
  },
  getDefaultInstallCommand(): string { return 'composer install --no-dev --optimize-autoloader'; },
  getHealthCheckPath(): string { return '/'; },

  _laravel(copyPrefix: string, rootDir: string, port: number, cmds: PhpCommands): string {
    const install = cmds.install || 'composer install --no-dev --optimize-autoloader --no-scripts';
    const build = cmds.build
      ? `RUN ${cmds.build}`
      : `RUN composer dump-autoload --optimize \\
    && php artisan config:cache 2>/dev/null || true \\
    && php artisan route:cache 2>/dev/null || true`;
    return `FROM php:8.3-fpm-alpine

RUN apk add --no-cache nginx supervisor curl \\
    && docker-php-ext-install pdo pdo_mysql opcache

RUN curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer

WORKDIR /var/www/html

COPY ${copyPrefix}composer.json ${copyPrefix}composer.lock* ./
${composerInstallRun(install)}

COPY ${rootDir === '.' ? '.' : rootDir} .

${build}
RUN chown -R www-data:www-data storage bootstrap/cache

COPY <<'NGINX' /etc/nginx/http.d/default.conf
server {
    listen ${port};
    server_name _;
    root /var/www/html/public;
    index index.php;
    location / { try_files $uri $uri/ /index.php?$query_string; }
    location ~ \\.php$ {
        fastcgi_pass 127.0.0.1:9000;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }
}
NGINX

COPY <<'SUPERVISOR' /etc/supervisord.conf
[supervisord]
nodaemon=true
[program:php-fpm]
command=php-fpm -F
[program:nginx]
command=nginx -g "daemon off;"
SUPERVISOR

EXPOSE ${port}
${cmds.start ? shCmd(cmds.start) : 'CMD ["supervisord", "-c", "/etc/supervisord.conf"]'}
`;
  },

  _generic(copyPrefix: string, rootDir: string, port: number, cmds: PhpCommands): string {
    const install = cmds.install || 'composer install --no-dev --optimize-autoloader';
    const build = cmds.build ? `RUN ${cmds.build}\n` : '';
    return `FROM php:8.3-apache

RUN a2enmod rewrite

WORKDIR /var/www/html

COPY ${rootDir === '.' ? '.' : rootDir} .

RUN if [ -f composer.json ]; then \\
    curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer \\
    && ${install}; fi
${build}
RUN chown -R www-data:www-data /var/www/html

EXPOSE ${port}
ENV APACHE_PORT=${port}

RUN sed -i "s/80/${port}/g" /etc/apache2/sites-available/000-default.conf /etc/apache2/ports.conf

${cmds.start ? shCmd(cmds.start) : 'CMD ["apache2-foreground"]'}
`;
  },
} as Buildpack & Record<string, any>;
