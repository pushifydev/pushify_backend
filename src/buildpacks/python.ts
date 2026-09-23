import { promises as fs } from 'fs';
import path from 'path';
import { pipInstallRun } from '../lib/platform-docker';
import type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';

type PyCommands = { install?: string | null; build?: string | null; start?: string | null };

/** `CMD ["sh", "-c", …]` so a start command may use env vars, `&&` and pipes. */
const shCmd = (cmd: string): string => `CMD ["sh", "-c", ${JSON.stringify(cmd)}]`;

/**
 * Dependency install that works for requirements.txt, pyproject.toml and Pipfile alike — the
 * old `COPY requirements.txt` failed the build of any Poetry/Pipenv project — unless the person
 * gave their own install command (dashboard or pushify.yaml), which then runs verbatim.
 */
function installLines(copyPrefix: string, install?: string | null): string {
  if (install) {
    return `COPY ${copyPrefix}. .
${pipInstallRun(install)}`;
  }
  return `COPY ${copyPrefix}requirements.txt* ${copyPrefix}Pipfile* ${copyPrefix}Pipfile.lock* ${copyPrefix}pyproject.toml* ${copyPrefix}poetry.lock* ./
${pipInstallRun(
  // No --no-cache-dir: that flag stops pip reading *or* writing its cache, which made the
  // BuildKit cache mount below it pointless — every deploy re-downloaded every wheel from
  // PyPI. The usual reason to pass it is image size, and a cache mount does not end up in the
  // image at all, so there is nothing to save here.
  `if [ -f requirements.txt ]; then pip install -r requirements.txt; \\
    elif [ -f Pipfile ]; then pip install pipenv && pipenv install --deploy --system; \\
    elif [ -f pyproject.toml ]; then pip install .; fi`
)}`;
}

export const pythonBuildpack: Buildpack = {
  id: 'python',
  name: 'Python',
  frameworks: ['django', 'flask', 'fastapi', 'python'],

  async detect(workDir: string, rootDir: string): Promise<BuildpackDetectResult> {
    const base = path.join(workDir, rootDir === '.' ? '' : rootDir);

    try {
      // Check requirements.txt
      const reqPath = path.join(base, 'requirements.txt');
      const content = await fs.readFile(reqPath, 'utf-8').catch(() => '');

      if (content) {
        if (content.includes('django') || content.includes('Django')) return { detected: true, framework: 'django', confidence: 95 };
        if (content.includes('flask') || content.includes('Flask')) return { detected: true, framework: 'flask', confidence: 95 };
        if (content.includes('fastapi') || content.includes('FastAPI')) return { detected: true, framework: 'fastapi', confidence: 95 };
        return { detected: true, framework: 'python', confidence: 80 };
      }

      // Check Pipfile
      const pipfile = await fs.readFile(path.join(base, 'Pipfile'), 'utf-8').catch(() => '');
      if (pipfile) {
        if (pipfile.includes('django')) return { detected: true, framework: 'django', confidence: 90 };
        if (pipfile.includes('flask')) return { detected: true, framework: 'flask', confidence: 90 };
        if (pipfile.includes('fastapi')) return { detected: true, framework: 'fastapi', confidence: 90 };
        return { detected: true, framework: 'python', confidence: 75 };
      }

      // Check pyproject.toml
      const pyproject = await fs.readFile(path.join(base, 'pyproject.toml'), 'utf-8').catch(() => '');
      if (pyproject) {
        if (pyproject.includes('django')) return { detected: true, framework: 'django', confidence: 90 };
        if (pyproject.includes('flask')) return { detected: true, framework: 'flask', confidence: 90 };
        if (pyproject.includes('fastapi')) return { detected: true, framework: 'fastapi', confidence: 90 };
        return { detected: true, framework: 'python', confidence: 75 };
      }

      // Check for manage.py (Django)
      const managePy = await fs.access(path.join(base, 'manage.py')).then(() => true).catch(() => false);
      if (managePy) return { detected: true, framework: 'django', confidence: 85 };

      // Check for app.py or main.py
      const appPy = await fs.access(path.join(base, 'app.py')).then(() => true).catch(() => false);
      const mainPy = await fs.access(path.join(base, 'main.py')).then(() => true).catch(() => false);
      if (appPy || mainPy) return { detected: true, framework: 'python', confidence: 60 };

      return { detected: false, framework: '', confidence: 0 };
    } catch {
      return { detected: false, framework: '', confidence: 0 };
    }
  },

  generateDockerfile(config: BuildpackConfig): string {
    const framework = (config as any).framework || 'python';
    const port = config.port || this.getDefaultPort(framework);
    const rootDir = config.rootDirectory || '.';
    const workdir = rootDir === '.' || rootDir === './' ? '/app' : `/app/${rootDir}`;
    const copyPrefix = rootDir === '.' ? '' : rootDir + '/';
    // install / build / start from the dashboard or pushify.yaml win over the framework defaults
    // (they used to be ignored by every Python path but the generic one).
    const cmds: PyCommands = { install: config.installCommand, build: config.buildCommand, start: config.startCommand };

    if (framework === 'django') return this._django(workdir, copyPrefix, rootDir, port, cmds);
    if (framework === 'fastapi') return this._fastapi(workdir, copyPrefix, rootDir, port, cmds);
    if (framework === 'flask') return this._flask(workdir, copyPrefix, rootDir, port, cmds);
    return this._generic(workdir, copyPrefix, rootDir, port, cmds);
  },

  getDefaultPort(framework?: string): number {
    if (framework === 'django') return 8000;
    if (framework === 'fastapi') return 8000;
    if (framework === 'flask') return 5000;
    return 8000;
  },

  getDefaultBuildCommand(framework?: string): string {
    if (framework === 'django') return 'python manage.py collectstatic --noinput';
    return '';
  },

  getDefaultStartCommand(framework?: string): string {
    if (framework === 'django') return 'gunicorn <project>.wsgi:application --bind 0.0.0.0:8000';
    if (framework === 'fastapi') return 'uvicorn main:app --host 0.0.0.0 --port 8000';
    if (framework === 'flask') return 'gunicorn app:app --bind 0.0.0.0:5000';
    return 'python main.py';
  },

  getDefaultInstallCommand(): string {
    // Cached by the mount in `pipInstallRun`; see the note there about --no-cache-dir
    return 'pip install -r requirements.txt';
  },

  getHealthCheckPath(): string {
    return '/';
  },

  _django(workdir: string, copyPrefix: string, rootDir: string, port: number, cmds: PyCommands): string {
    // The wsgi module is found at start-up (`<project>/wsgi.py`); the old CMD hard-coded
    // `config.wsgi`, which only matched projects literally named config.
    const startDefault =
      'WSGI=$(ls -1 */wsgi.py 2>/dev/null | head -n1 | sed s#/wsgi.py## | tr / .); ' +
      `exec gunicorn \${WSGI:-config}.wsgi:application --bind 0.0.0.0:${port} --workers 3 --timeout 120`;
    const build = cmds.build ? `RUN ${cmds.build}` : 'RUN python manage.py collectstatic --noinput 2>/dev/null || true';
    return `FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    gcc libpq-dev && rm -rf /var/lib/apt/lists/*

WORKDIR ${workdir}

${installLines(copyPrefix, cmds.install)}

COPY ${rootDir === '.' ? '.' : rootDir} .

${build}

EXPOSE ${port}
ENV PORT=${port}

${shCmd(cmds.start || startDefault)}
`;
  },

  _fastapi(workdir: string, copyPrefix: string, rootDir: string, port: number, cmds: PyCommands): string {
    const build = cmds.build ? `RUN ${cmds.build}\n` : '';
    return `FROM python:3.12-slim

WORKDIR ${workdir}

${installLines(copyPrefix, cmds.install)}

COPY ${rootDir === '.' ? '.' : rootDir} .
${build}
EXPOSE ${port}
ENV PORT=${port}

${shCmd(cmds.start || `uvicorn main:app --host 0.0.0.0 --port ${port} --workers 2`)}
`;
  },

  _flask(workdir: string, copyPrefix: string, rootDir: string, port: number, cmds: PyCommands): string {
    const build = cmds.build ? `RUN ${cmds.build}\n` : '';
    return `FROM python:3.12-slim

WORKDIR ${workdir}

${installLines(copyPrefix, cmds.install)}

COPY ${rootDir === '.' ? '.' : rootDir} .
${build}
EXPOSE ${port}
ENV PORT=${port}
ENV FLASK_ENV=production

${shCmd(cmds.start || `gunicorn app:app --bind 0.0.0.0:${port} --workers 3`)}
`;
  },

  _generic(workdir: string, copyPrefix: string, rootDir: string, port: number, cmds: PyCommands): string {
    const build = cmds.build ? `RUN ${cmds.build}\n` : '';
    return `FROM python:3.12-slim

WORKDIR ${workdir}

${installLines(copyPrefix, cmds.install)}

COPY ${rootDir === '.' ? '.' : rootDir} .
${build}
EXPOSE ${port}
ENV PORT=${port}

${shCmd(cmds.start || 'python main.py')}
`;
  },
} as Buildpack & Record<string, any>;
