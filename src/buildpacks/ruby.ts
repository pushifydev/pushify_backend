import { promises as fs } from 'fs';
import path from 'path';
import type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';
import { bundleInstallRun } from '../lib/platform-docker';

type RubyCommands = { install?: string | null; build?: string | null; start?: string | null };

/** `CMD ["sh", "-c", …]` so a start command may use env vars, `&&` and pipes. */
const shCmd = (cmd: string): string => `CMD ["sh", "-c", ${JSON.stringify(cmd)}]`;

export const rubyBuildpack: Buildpack = {
  id: 'ruby',
  name: 'Ruby',
  frameworks: ['rails', 'sinatra', 'ruby'],

  async detect(workDir: string, rootDir: string): Promise<BuildpackDetectResult> {
    const base = path.join(workDir, rootDir === '.' ? '' : rootDir);
    try {
      const gemfile = await fs.readFile(path.join(base, 'Gemfile'), 'utf-8').catch(() => '');
      if (!gemfile) return { detected: false, framework: '', confidence: 0 };

      if (gemfile.includes("'rails'") || gemfile.includes('"rails"')) return { detected: true, framework: 'rails', confidence: 95 };
      if (gemfile.includes("'sinatra'") || gemfile.includes('"sinatra"')) return { detected: true, framework: 'sinatra', confidence: 90 };
      return { detected: true, framework: 'ruby', confidence: 75 };
    } catch {
      return { detected: false, framework: '', confidence: 0 };
    }
  },

  generateDockerfile(config: BuildpackConfig): string {
    const framework = (config as any).framework || 'ruby';
    const port = config.port || 3000;
    const rootDir = config.rootDirectory || '.';
    const copyPrefix = rootDir === '.' ? '' : rootDir + '/';

    const cmds = { install: config.installCommand, build: config.buildCommand, start: config.startCommand };
    if (framework === 'rails') return this._rails(copyPrefix, rootDir, port, cmds);
    return this._generic(copyPrefix, rootDir, port, cmds);
  },

  getDefaultPort(): number { return 3000; },
  getDefaultBuildCommand(framework?: string): string {
    if (framework === 'rails') return 'bundle exec rails assets:precompile';
    return '';
  },
  getDefaultStartCommand(framework?: string): string {
    if (framework === 'rails') return 'bundle exec rails server -b 0.0.0.0';
    return 'bundle exec ruby app.rb';
  },
  getDefaultInstallCommand(): string { return 'bundle install --without development test'; },
  getHealthCheckPath(): string { return '/'; },

  _rails(copyPrefix: string, rootDir: string, port: number, cmds: RubyCommands): string {
    const install = cmds.install || `bundle config set --local without 'development test' \\
    && bundle install --jobs 4 --retry 3`;
    const build = cmds.build
      ? `RUN ${cmds.build}`
      : `RUN bundle exec rails assets:precompile 2>/dev/null || true \\
    && bundle exec rails db:migrate 2>/dev/null || true`;
    return `FROM ruby:3.3-slim

RUN apt-get update -qq && apt-get install -y --no-install-recommends \\
    build-essential libpq-dev nodejs npm && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ${copyPrefix}Gemfile ${copyPrefix}Gemfile.lock* ./
${bundleInstallRun(install)}

COPY ${rootDir === '.' ? '.' : rootDir} .

${build}

EXPOSE ${port}
ENV PORT=${port}
ENV RAILS_ENV=production
ENV RAILS_SERVE_STATIC_FILES=true
ENV RAILS_LOG_TO_STDOUT=true

${cmds.start ? shCmd(cmds.start) : `CMD ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "${port}"]`}
`;
  },

  _generic(copyPrefix: string, rootDir: string, port: number, cmds: RubyCommands): string {
    const install = cmds.install || 'bundle install --without development test';
    const build = cmds.build ? `RUN ${cmds.build}\n` : '';
    return `FROM ruby:3.3-slim

RUN apt-get update -qq && apt-get install -y --no-install-recommends \\
    build-essential && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ${copyPrefix}Gemfile ${copyPrefix}Gemfile.lock* ./
${bundleInstallRun(install)}

COPY ${rootDir === '.' ? '.' : rootDir} .
${build}
EXPOSE ${port}
ENV PORT=${port}

${shCmd(cmds.start || 'bundle exec ruby app.rb')}
`;
  },
} as Buildpack & Record<string, any>;
