import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';

// selfhost/update.sh run in a real shell against real git checkouts (cloned --depth 1 like the
// installer does) with a fake `docker` that only records what it was asked to do.
const SCRIPT = path.resolve(__dirname, '../../selfhost/update.sh');
// Inside the repo (git-ignored) rather than os.tmpdir(): a noexec /tmp would stop the fake
// docker from running at all.
const FAKE_ROOT = path.join(process.cwd(), 'node_modules', '.cache', 'selfhost-update-test');

type Release = { version: string; date: string; security?: boolean };

let root: string;
let env: NodeJS.ProcessEnv;
let releases: Release[];

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();
const backendOrigin = () => path.join(root, 'origin', 'pushify_backend');
const frontendOrigin = () => path.join(root, 'origin', 'pushify_frontend');
const install = () => path.join(root, 'pushify');
const dockerCalls = () => (existsSync(env.DOCKER_LOG!) ? readFileSync(env.DOCKER_LOG!, 'utf8') : '');
const composeUps = () => dockerCalls().split('\n').filter((l) => l === 'compose up -d --build').length;
const installedVersion = () => JSON.parse(readFileSync(path.join(install(), 'pushify_backend', 'package.json'), 'utf8')).version;

function changelog(): string {
  const sections = [...releases].reverse().map((r) =>
    `## [${r.version}] - ${r.date}\n\n### ${r.security ? 'Security' : 'Fixed'}\n- Something in ${r.version}.\n`,
  );
  return `# Changelog\n\n## [Unreleased]\n\n${sections.join('\n')}`;
}

function release(r: Release) {
  releases.push(r);
  const dir = backendOrigin();
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'pushify-backend', version: r.version }, null, 2));
  writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog());
  writeFileSync(path.join(dir, 'selfhost', 'docker-compose.yml'), `# compose for ${r.version}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', `release ${r.version}`);
}

function run(...args: string[]) {
  const res = spawnSync('bash', [SCRIPT, ...args], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: res.status, out: res.stdout + res.stderr };
}

beforeEach(() => {
  mkdirSync(FAKE_ROOT, { recursive: true });
  root = mkdtempSync(path.join(FAKE_ROOT, 'install-'));
  const bin = path.join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'docker'),
    '#!/usr/bin/env bash\necho "$*" >> "$DOCKER_LOG"\n[ "$1 $2" = "compose up" ] && [ -n "${DOCKER_FAIL_UP:-}" ] && exit 1\nexit 0\n',
  );
  chmodSync(path.join(bin, 'docker'), 0o755);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    DOCKER_LOG: path.join(root, 'docker.log'),
    PUSHIFY_DIR: path.join(root, 'pushify'),
  };
  releases = [];

  mkdirSync(path.join(backendOrigin(), 'selfhost'), { recursive: true });
  mkdirSync(frontendOrigin(), { recursive: true });
  git(backendOrigin(), 'init', '-q', '-b', 'master');
  git(frontendOrigin(), 'init', '-q', '-b', 'master');
  release({ version: '0.6.0', date: '2026-10-21' });
  writeFileSync(path.join(frontendOrigin(), 'README.md'), 'dashboard v1\n');
  git(frontendOrigin(), 'add', '-A');
  git(frontendOrigin(), 'commit', '-qm', 'dashboard v1');

  mkdirSync(install());
  git(install(), 'clone', '-q', '--depth', '1', `file://${backendOrigin()}`, 'pushify_backend');
  git(install(), 'clone', '-q', '--depth', '1', `file://${frontendOrigin()}`, 'pushify_frontend');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('selfhost/update.sh', () => {
  it('--dry-run lists the releases since the installed version, warns to back up and changes nothing', () => {
    release({ version: '0.6.1', date: '2026-10-22' });
    release({ version: '0.6.2', date: '2026-10-23', security: true });

    const { status, out } = run('--dry-run');

    expect(status).toBe(0);
    expect(out).toContain('0.6.0');
    expect(out).toMatch(/0\.6\.2 {2}2026-10-23 {2}\[security\]/);
    expect(out).toMatch(/0\.6\.1 {2}2026-10-22\n/);
    expect(out).not.toMatch(/0\.6\.0 {2}2026-10-21/);
    expect(out).toContain('Back up before updating');
    expect(out).toContain('pg_dump');
    expect(out).toContain('Nothing was changed');
    expect(installedVersion()).toBe('0.6.0');
    expect(composeUps()).toBe(0);
    expect(existsSync(path.join(install(), 'docker-compose.yml'))).toBe(false);
    expect(existsSync(path.join(install(), '.pushify-deployed'))).toBe(false);
  });

  it('updates both checkouts and the compose file once, then does nothing on the next run', () => {
    release({ version: '0.6.1', date: '2026-10-22', security: true });
    writeFileSync(path.join(frontendOrigin(), 'README.md'), 'dashboard v2\n');
    git(frontendOrigin(), 'commit', '-qam', 'dashboard v2');

    const first = run('--yes');
    expect(first.status).toBe(0);
    expect(first.out).toContain('Back up before updating');
    expect(installedVersion()).toBe('0.6.1');
    expect(readFileSync(path.join(install(), 'pushify_frontend', 'README.md'), 'utf8')).toBe('dashboard v2\n');
    expect(readFileSync(path.join(install(), 'docker-compose.yml'), 'utf8')).toBe('# compose for 0.6.1\n');
    expect(composeUps()).toBe(1);

    const second = run('--yes');
    expect(second.status).toBe(0);
    expect(second.out).toContain('0.6.1 is up to date');
    expect(composeUps()).toBe(1);
  });

  it('builds again on the next run when the previous build failed', () => {
    release({ version: '0.6.1', date: '2026-10-22' });

    env.DOCKER_FAIL_UP = '1';
    const failed = run('--yes');
    expect(failed.status).not.toBe(0);
    expect(installedVersion()).toBe('0.6.1');
    expect(existsSync(path.join(install(), '.pushify-deployed'))).toBe(false);

    delete env.DOCKER_FAIL_UP;
    const retried = run('--yes');
    expect(retried.status).toBe(0);
    expect(retried.out).toContain('the stack will be rebuilt');
    expect(composeUps()).toBe(2);
    expect(run('--yes').out).toContain('up to date');
  });

  it('refuses a MAJOR version jump unless --allow-major is given', () => {
    release({ version: '1.0.0', date: '2026-10-24' });

    const refused = run('--yes');
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('MAJOR version change');
    expect(installedVersion()).toBe('0.6.0');
    expect(composeUps()).toBe(0);

    const allowed = run('--yes', '--allow-major');
    expect(allowed.status).toBe(0);
    expect(installedVersion()).toBe('1.0.0');
  });

  it('runs piped into bash (curl | bash) from the install directory without PUSHIFY_DIR', () => {
    release({ version: '0.6.1', date: '2026-10-22' });
    const { PUSHIFY_DIR: _unused, ...rest } = env;
    const res = spawnSync('bash', ['-s', '--', '--dry-run'], {
      cwd: install(),
      env: rest,
      input: readFileSync(SCRIPT),
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/0\.6\.1 {2}2026-10-22/);
    expect(installedVersion()).toBe('0.6.0');
  });

  it('stops before touching anything when a checkout has local changes', () => {
    release({ version: '0.6.1', date: '2026-10-22' });
    writeFileSync(path.join(install(), 'pushify_backend', 'CHANGELOG.md'), 'edited\n');

    const { status, out } = run('--yes');
    expect(status).toBe(1);
    expect(out).toContain('pushify_backend has local changes');
    expect(installedVersion()).toBe('0.6.0');
    expect(composeUps()).toBe(0);
  });
});
