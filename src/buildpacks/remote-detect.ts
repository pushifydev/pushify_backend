import path from 'path';
import type { DetectionResult } from './detector';
import { detectNodeFrameworkFromPackageJson } from './nodejs-detect';

function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

type SshExec = {
  exec: (command: string) => Promise<{ stdout: string; stderr?: string; code: number }>;
};

async function sshRead(ssh: SshExec, filePath: string): Promise<string | null> {
  const q = shellQuote(filePath);
  const r = await ssh.exec(`cat ${q} 2>/dev/null || true`);
  const t = r.stdout.trim();
  return t.length > 0 ? t : null;
}

async function sshExists(ssh: SshExec, filePath: string): Promise<boolean> {
  const q = shellQuote(filePath);
  const r = await ssh.exec(`test -e ${q} && echo yes || echo no`);
  return r.stdout.trim() === 'yes';
}

export function detectPythonFromFiles(input: {
  requirements?: string | null;
  pipfile?: string | null;
  pyproject?: string | null;
  hasManagePy?: boolean;
  hasAppPy?: boolean;
  hasMainPy?: boolean;
}): DetectionResult | null {
  const { requirements, pipfile, pyproject, hasManagePy, hasAppPy, hasMainPy } = input;

  const scan = (text: string) => {
    if (text.includes('django') || text.includes('Django'))
      return { buildpackId: 'python', framework: 'django', confidence: 95 };
    if (text.includes('flask') || text.includes('Flask'))
      return { buildpackId: 'python', framework: 'flask', confidence: 95 };
    if (text.includes('fastapi') || text.includes('FastAPI'))
      return { buildpackId: 'python', framework: 'fastapi', confidence: 95 };
    return { buildpackId: 'python', framework: 'python', confidence: 80 };
  };

  if (requirements) return scan(requirements);
  if (pipfile) return scan(pipfile);
  if (pyproject) return scan(pyproject);
  if (hasManagePy) return { buildpackId: 'python', framework: 'django', confidence: 85 };
  if (hasAppPy || hasMainPy) return { buildpackId: 'python', framework: 'python', confidence: 60 };

  return null;
}

export function detectGoFromGoMod(goMod: string): DetectionResult | null {
  if (!goMod.trim()) return null;
  if (goMod.includes('github.com/gin-gonic/gin'))
    return { buildpackId: 'go', framework: 'gin', confidence: 95 };
  if (goMod.includes('github.com/gofiber/fiber'))
    return { buildpackId: 'go', framework: 'fiber', confidence: 95 };
  if (goMod.includes('github.com/labstack/echo'))
    return { buildpackId: 'go', framework: 'echo', confidence: 95 };
  if (goMod.includes('github.com/go-chi/chi'))
    return { buildpackId: 'go', framework: 'chi', confidence: 95 };
  return { buildpackId: 'go', framework: 'go', confidence: 85 };
}

export function detectPhpFromComposer(composer: string, hasIndexPhp: boolean): DetectionResult | null {
  if (composer) {
    if (composer.includes('laravel/framework'))
      return { buildpackId: 'php', framework: 'laravel', confidence: 95 };
    if (composer.includes('symfony/framework-bundle'))
      return { buildpackId: 'php', framework: 'symfony', confidence: 95 };
    return { buildpackId: 'php', framework: 'php', confidence: 80 };
  }
  if (hasIndexPhp) return { buildpackId: 'php', framework: 'php', confidence: 60 };
  return null;
}

export function detectRubyFromGemfile(gemfile: string): DetectionResult | null {
  if (!gemfile.trim()) return null;
  if (gemfile.includes("'rails'") || gemfile.includes('"rails"'))
    return { buildpackId: 'ruby', framework: 'rails', confidence: 95 };
  if (gemfile.includes("'sinatra'") || gemfile.includes('"sinatra"'))
    return { buildpackId: 'ruby', framework: 'sinatra', confidence: 90 };
  return { buildpackId: 'ruby', framework: 'ruby', confidence: 75 };
}

export function detectRustFromCargo(cargo: string): DetectionResult | null {
  if (!cargo.trim()) return null;
  if (cargo.includes('actix-web')) return { buildpackId: 'rust', framework: 'actix', confidence: 95 };
  if (cargo.includes('axum')) return { buildpackId: 'rust', framework: 'axum', confidence: 95 };
  if (cargo.includes('rocket')) return { buildpackId: 'rust', framework: 'rocket', confidence: 95 };
  return { buildpackId: 'rust', framework: 'rust', confidence: 85 };
}

export function detectJavaFromFiles(pom: string | null, gradle: string | null): DetectionResult | null {
  if (pom) {
    if (pom.includes('spring-boot'))
      return { buildpackId: 'java', framework: 'spring', confidence: 95 };
    return { buildpackId: 'java', framework: 'maven', confidence: 85 };
  }
  if (gradle) {
    if (gradle.includes('spring-boot'))
      return { buildpackId: 'java', framework: 'spring', confidence: 95 };
    return { buildpackId: 'java', framework: 'gradle', confidence: 85 };
  }
  return null;
}

/**
 * Detect language/framework on the deployment host via SSH (not local filesystem).
 */
export async function detectBuildpackRemote(
  ssh: SshExec,
  workDir: string,
  rootDir: string = '.'
): Promise<DetectionResult | null> {
  const base = rootDir === '.' ? workDir : path.posix.join(workDir, rootDir);

  if (await sshExists(ssh, `${base}/Dockerfile`)) {
    return { buildpackId: 'custom', framework: 'dockerfile', confidence: 100 };
  }

  const pkgRaw = await sshRead(ssh, `${base}/package.json`);
  if (pkgRaw) {
    try {
      const pkg = JSON.parse(pkgRaw) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const node = detectNodeFrameworkFromPackageJson(pkg);
      if (node.detected) {
        return { buildpackId: 'nodejs', framework: node.framework, confidence: node.confidence };
      }
    } catch {
      /* invalid package.json */
    }
  }

  const goMod = await sshRead(ssh, `${base}/go.mod`);
  const goHit = goMod ? detectGoFromGoMod(goMod) : null;
  if (goHit) return goHit;

  const pyHit = detectPythonFromFiles({
    requirements: await sshRead(ssh, `${base}/requirements.txt`),
    pipfile: await sshRead(ssh, `${base}/Pipfile`),
    pyproject: await sshRead(ssh, `${base}/pyproject.toml`),
    hasManagePy: await sshExists(ssh, `${base}/manage.py`),
    hasAppPy: await sshExists(ssh, `${base}/app.py`),
    hasMainPy: await sshExists(ssh, `${base}/main.py`),
  });
  if (pyHit) return pyHit;

  const composer = await sshRead(ssh, `${base}/composer.json`);
  const phpHit = detectPhpFromComposer(composer || '', await sshExists(ssh, `${base}/index.php`));
  if (phpHit) return phpHit;

  const gemfile = await sshRead(ssh, `${base}/Gemfile`);
  const rubyHit = gemfile ? detectRubyFromGemfile(gemfile) : null;
  if (rubyHit) return rubyHit;

  const cargo = await sshRead(ssh, `${base}/Cargo.toml`);
  const rustHit = cargo ? detectRustFromCargo(cargo) : null;
  if (rustHit) return rustHit;

  const javaHit = detectJavaFromFiles(
    await sshRead(ssh, `${base}/pom.xml`),
    (await sshRead(ssh, `${base}/build.gradle`)) ||
      (await sshRead(ssh, `${base}/build.gradle.kts`))
  );
  if (javaHit) return javaHit;

  if (await sshExists(ssh, `${base}/index.html`)) {
    return { buildpackId: 'static', framework: 'static', confidence: 50 };
  }

  return null;
}

/** True when next.config enables output: 'standalone' (safe for slim runner image). */
export function detectNextStandaloneFromConfig(content: string): boolean {
  return /output\s*:\s*['"]standalone['"]/m.test(content);
}

export async function detectNextStandaloneRemote(
  ssh: SshExec,
  workDir: string,
  rootDir: string = '.'
): Promise<boolean> {
  const base = rootDir === '.' ? workDir : path.posix.join(workDir, rootDir);
  const baseQ = shellQuote(base);
  for (const name of ['next.config.ts', 'next.config.mjs', 'next.config.js', 'next.config.cjs']) {
    const raw = await ssh.exec(`cat ${baseQ}/${name} 2>/dev/null || true`);
    if (raw.stdout.trim() && detectNextStandaloneFromConfig(raw.stdout)) {
      return true;
    }
  }
  return false;
}
