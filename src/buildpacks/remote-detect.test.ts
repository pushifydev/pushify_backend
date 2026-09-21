import { describe, it, expect } from 'vitest';
import { detectBuildpackRemote } from './remote-detect';
import { buildpackIdForFramework } from './index';

/** A repo as a path → content map served over a fake ssh (`cat` / `test -e` / page `find`). */
function fakeSsh(files: Record<string, string>) {
  const commands: string[] = [];
  return {
    commands,
    exec: async (command: string) => {
      commands.push(command);
      const find = command.match(/^find '([^']+)' -maxdepth 2/);
      if (find) {
        const prefix = find[1].replace('/repo', '').replace(/^\//, '');
        const pages = Object.keys(files)
          .filter((f) => (prefix ? f.startsWith(`${prefix}/`) : true))
          .map((f) => (prefix ? f.slice(prefix.length + 1) : f))
          .filter((f) => /\.html?$/i.test(f) && f.split('/').length <= 2)
          .map((f) => `${find[1]}/${f}`);
        return { stdout: pages.join('\n'), code: 0 };
      }
      const m = command.match(/^(cat|test -e) '([^']+)'/);
      if (!m) return { stdout: '', code: 0 };
      const content = files[m[2].replace('/repo/', '')];
      if (m[1] === 'cat') return { stdout: content ?? '', code: 0 };
      return { stdout: content !== undefined ? 'yes' : 'no', code: 0 };
    },
  };
}

const laravelComposer = JSON.stringify({ require: { 'laravel/framework': '^11.0' } });
const vitePackage = JSON.stringify({ devDependencies: { vite: '^5.0.0', axios: '^1.6.0' } });

describe('detectBuildpackRemote', () => {
  it('picks Laravel over the front-end package.json that ships next to it', async () => {
    const ssh = fakeSsh({ 'composer.json': laravelComposer, 'package.json': vitePackage, 'artisan': '' });
    const hit = await detectBuildpackRemote(ssh, '/repo');
    expect(hit).toMatchObject({ buildpackId: 'php', framework: 'laravel' });
  });

  it('picks Rails over the package.json of its asset pipeline', async () => {
    const ssh = fakeSsh({ Gemfile: "gem 'rails', '~> 7.1'", 'package.json': vitePackage });
    const hit = await detectBuildpackRemote(ssh, '/repo');
    expect(hit).toMatchObject({ buildpackId: 'ruby', framework: 'rails' });
  });

  it('picks Django over a package.json used only for tailwind', async () => {
    const ssh = fakeSsh({
      'requirements.txt': 'Django==5.0\ngunicorn',
      'manage.py': '',
      'package.json': JSON.stringify({ devDependencies: { tailwindcss: '^3' } }),
    });
    const hit = await detectBuildpackRemote(ssh, '/repo');
    expect(hit).toMatchObject({ buildpackId: 'python', framework: 'django' });
  });

  it('detects a static site kept in a subfolder or with a capitalised Index.html', async () => {
    expect(await detectBuildpackRemote(fakeSsh({ 'site/index.html': '', 'nginx.conf': '' }), '/repo')).toMatchObject({
      buildpackId: 'static',
      confidence: 40,
    });
    expect(await detectBuildpackRemote(fakeSsh({ 'Index.html': '' }), '/repo')).toMatchObject({
      buildpackId: 'static',
      confidence: 50,
    });
  });

  it('still builds a Node app as Node when only package.json and index.html exist', async () => {
    const ssh = fakeSsh({ 'package.json': JSON.stringify({ dependencies: { express: '^4' } }), 'index.html': '' });
    const hit = await detectBuildpackRemote(ssh, '/repo');
    expect(hit).toMatchObject({ buildpackId: 'nodejs', framework: 'express' });
  });

  it('prefers a Dockerfile over everything', async () => {
    const ssh = fakeSsh({ Dockerfile: 'FROM alpine', 'package.json': vitePackage });
    const hit = await detectBuildpackRemote(ssh, '/repo');
    expect(hit).toMatchObject({ buildpackId: 'custom', framework: 'dockerfile' });
  });

  it('honours the root directory', async () => {
    const ssh = fakeSsh({ 'apps/api/go.mod': 'module example.com/api\n\nrequire github.com/gin-gonic/gin v1.9.0' });
    const hit = await detectBuildpackRemote(ssh, '/repo', 'apps/api');
    expect(hit).toMatchObject({ buildpackId: 'go', framework: 'gin' });
  });

  it('returns null for an empty repo', async () => {
    expect(await detectBuildpackRemote(fakeSsh({}), '/repo')).toBeNull();
  });
});

describe('buildpackIdForFramework', () => {
  it('maps every framework name a buildpack owns to that buildpack', () => {
    expect(buildpackIdForFramework('laravel')).toBe('php');
    expect(buildpackIdForFramework('rails')).toBe('ruby');
    expect(buildpackIdForFramework('django')).toBe('python');
    expect(buildpackIdForFramework('nextjs')).toBe('nodejs');
    expect(buildpackIdForFramework('gin')).toBe('go');
    expect(buildpackIdForFramework('axum')).toBe('rust');
    expect(buildpackIdForFramework('spring')).toBe('java');
    expect(buildpackIdForFramework('static')).toBe('static');
  });

  it('is null for names no buildpack knows, so callers fall back to detection', () => {
    expect(buildpackIdForFramework('other')).toBeNull();
    expect(buildpackIdForFramework('')).toBeNull();
  });
});
