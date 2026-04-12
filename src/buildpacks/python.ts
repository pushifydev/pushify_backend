import { promises as fs } from 'fs';
import path from 'path';
import type { Buildpack, BuildpackDetectResult, BuildpackConfig } from './types';

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

    if (framework === 'django') return this._django(workdir, copyPrefix, rootDir, port);
    if (framework === 'fastapi') return this._fastapi(workdir, copyPrefix, rootDir, port);
    if (framework === 'flask') return this._flask(workdir, copyPrefix, rootDir, port);
    return this._generic(workdir, copyPrefix, rootDir, port, config.startCommand);
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
    if (framework === 'django') return 'gunicorn config.wsgi:application --bind 0.0.0.0:8000';
    if (framework === 'fastapi') return 'uvicorn main:app --host 0.0.0.0 --port 8000';
    if (framework === 'flask') return 'gunicorn app:app --bind 0.0.0.0:5000';
    return 'python main.py';
  },

  getDefaultInstallCommand(): string {
    return 'pip install --no-cache-dir -r requirements.txt';
  },

  getHealthCheckPath(): string {
    return '/';
  },

  _django(workdir: string, copyPrefix: string, rootDir: string, port: number): string {
    return `FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \\
    gcc libpq-dev && rm -rf /var/lib/apt/lists/*

WORKDIR ${workdir}

COPY ${copyPrefix}requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY ${rootDir === '.' ? '.' : rootDir} .

RUN python manage.py collectstatic --noinput 2>/dev/null || true

EXPOSE ${port}
ENV PORT=${port}

CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:${port}", "--workers", "3", "--timeout", "120"]
`;
  },

  _fastapi(workdir: string, copyPrefix: string, rootDir: string, port: number): string {
    return `FROM python:3.12-slim

WORKDIR ${workdir}

COPY ${copyPrefix}requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY ${rootDir === '.' ? '.' : rootDir} .

EXPOSE ${port}
ENV PORT=${port}

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "${port}", "--workers", "2"]
`;
  },

  _flask(workdir: string, copyPrefix: string, rootDir: string, port: number): string {
    return `FROM python:3.12-slim

WORKDIR ${workdir}

COPY ${copyPrefix}requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY ${rootDir === '.' ? '.' : rootDir} .

EXPOSE ${port}
ENV PORT=${port}
ENV FLASK_ENV=production

CMD ["gunicorn", "app:app", "--bind", "0.0.0.0:${port}", "--workers", "3"]
`;
  },

  _generic(workdir: string, copyPrefix: string, rootDir: string, port: number, startCmd?: string | null): string {
    const cmd = startCmd || 'python main.py';
    return `FROM python:3.12-slim

WORKDIR ${workdir}

COPY ${copyPrefix}requirements.txt* ${copyPrefix}Pipfile* ${copyPrefix}pyproject.toml* ./
RUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; \\
    elif [ -f Pipfile ]; then pip install pipenv && pipenv install --deploy --system; \\
    elif [ -f pyproject.toml ]; then pip install .; fi

COPY ${rootDir === '.' ? '.' : rootDir} .

EXPOSE ${port}
ENV PORT=${port}

CMD ${JSON.stringify(cmd.split(' '))}
`;
  },
} as Buildpack & Record<string, any>;
