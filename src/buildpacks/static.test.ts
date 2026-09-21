import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import path from 'path';
import { STATIC_SITE_SCRIPT, staticBuildpack } from './static';

/**
 * The static site script runs for real here (sh over a temp repo). What it guards: a site in a
 * subfolder showed "Welcome to nginx!", and `.git` — clone URL with token — was served.
 */
const run = promisify(execFile);
let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'pushify-static-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function repo(files: Record<string, string>): Promise<string> {
  const src = path.join(tmp, 'src');
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(src, name)), { recursive: true });
    await fs.writeFile(path.join(src, name), content);
  }
  return src;
}

async function prepare(files: Record<string, string>, port = 3000) {
  const src = await repo(files);
  const out = path.join(tmp, 'out');
  const script = path.join(tmp, 'static.sh');
  await fs.writeFile(script, STATIC_SITE_SCRIPT);
  const { stdout } = await run('sh', [script, String(port)], {
    env: { ...process.env, PUSHIFY_SRC: src, PUSHIFY_OUT: out },
  });
  const list = async (dir: string): Promise<string[]> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const names: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) names.push(...(await list(path.join(dir, e.name))).map((n) => `${e.name}/${n}`));
      else names.push(e.name);
    }
    return names.sort();
  };
  const read = (rel: string) => fs.readFile(path.join(out, rel), 'utf8').catch(() => null);
  return { stdout, html: await list(path.join(out, 'html')), read };
}

const GIT_CONFIG = '[remote "origin"]\n\turl = https://x-access-token:ghs_secret@github.com/acme/site\n';

describe('static site script', () => {
  it("serves the folder the repo's nginx.conf root points at — not the image's welcome page", async () => {
    const out = await prepare({
      'nginx.conf': 'server {\n    listen 80;\n    server_name yeliapp.com;\n    root /usr/share/nginx/html/site;\n    index index.html;\n}\n',
      'site/index.html': '<h1>Yeli</h1>',
      'site/about.html': 'about',
      'README.md': 'readme',
      '.git/config': GIT_CONFIG,
    });

    expect(out.html).toEqual(['about.html', 'index.html']);
    expect(await out.read('html/index.html')).toBe('<h1>Yeli</h1>');
    const conf = await out.read('conf/repo.conf');
    expect(conf).toContain('listen 3000;');
    expect(conf).toContain('root /usr/share/nginx/html;');
    expect(out.stdout).toContain('web root /site');
  });

  it('never copies .git, the Dockerfile, env files or the nginx config into the web root', async () => {
    const out = await prepare({
      'index.html': 'home',
      'style.css': 'body{}',
      'nginx.conf': 'server { listen 80; }\n',
      Dockerfile: 'FROM nginx:alpine',
      '.env': 'SECRET=1',
      '.git/config': GIT_CONFIG,
      '.github/workflows/ci.yml': 'on: push',
    });

    expect(out.html).toEqual(['index.html', 'style.css']);
  });

  it('finds a site that lives in a usual folder with no config at all', async () => {
    const out = await prepare({ 'public/index.html': 'pub', 'package-lock.json': '{}' });
    expect(out.html).toEqual(['index.html']);
  });

  it('uses a page named like a home page when there is no index.html, else the first page', async () => {
    const named = await prepare({ 'home.html': 'welcome home', 'contact.html': 'c' });
    expect(await named.read('html/index.html')).toBe('welcome home');
    expect(named.stdout).toContain('serving home.html as the home page');

    await fs.rm(path.join(tmp, 'src'), { recursive: true, force: true });
    await fs.rm(path.join(tmp, 'out'), { recursive: true, force: true });
    const first = await prepare({ 'contact.html': 'c', 'pricing.html': 'p' });
    expect(await first.read('html/index.html')).toBe('c');
  });

  it('accepts index.htm', async () => {
    const out = await prepare({ 'index.htm': 'old school' });
    expect(await out.read('conf/default.conf')).toContain('index index.html index.htm;');
    expect(await out.read('html/index.html')).toBe('old school');
  });

  it('drops TLS and HTTPS redirects from a config written for a VPS (they would loop behind the proxy)', async () => {
    const out = await prepare({
      'index.html': 'x',
      'nginx.conf': [
        'server {',
        '    listen 80;',
        '    return 301 https://$host$request_uri;',
        '}',
        'server {',
        '    listen 443 ssl http2;',
        '    listen [::]:443 ssl;',
        '    ssl_certificate /etc/letsencrypt/live/a/fullchain.pem;',
        '    ssl_certificate_key /etc/letsencrypt/live/a/privkey.pem;',
        '    root /var/www/a;',
        '    location /old { return 301 /new; }',
        '}',
        '',
      ].join('\n'),
    });

    const conf = (await out.read('conf/repo.conf'))!;
    expect(conf).not.toContain('https://');
    expect(conf).not.toContain('ssl');
    expect(conf).toContain('listen 3000;');
    expect(conf).toContain('listen [::]:3000;');
    expect(conf).toContain('location /old { return 301 /new; }');
  });

  it('ignores a config that only redirects to HTTPS', async () => {
    const out = await prepare({
      'index.html': 'x',
      'nginx.conf': 'server {\n    listen 80;\n    return 301 https://$host$request_uri;\n}\n',
    });
    expect(await out.read('conf/repo.conf')).toBeNull();
    expect(out.stdout).toContain('only redirects to HTTPS');
  });

  it('does not use a full nginx.conf (http { })', async () => {
    const out = await prepare({
      'index.html': 'x',
      'nginx.conf': 'events {}\nhttp {\n    server { listen 80; }\n}\n',
    });
    expect(await out.read('conf/repo.conf')).toBeNull();
    expect(out.stdout).toContain('full nginx config');
  });

  it('gives a site with a 404.html real 404s, and everything else the index.html fallback', async () => {
    const multi = await prepare({ 'index.html': 'i', '404.html': 'nf' });
    const multiConf = (await multi.read('conf/default.conf'))!;
    expect(multiConf).toContain('error_page 404 /404.html;');
    expect(multiConf).toContain('try_files $uri $uri.html $uri/ =404;');
    expect(multiConf).toContain('location ~ /\\.(?!well-known) { return 404; }');
  });
});

describe('staticBuildpack.generateDockerfile', () => {
  it('embeds the script and listens on the project port', () => {
    const dockerfile = staticBuildpack.generateDockerfile({ port: 3000 });
    const encoded = dockerfile.match(/echo '([A-Za-z0-9+/=]+)' \| base64 -d/)![1];

    expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(STATIC_SITE_SCRIPT);
    expect(dockerfile).toContain('sh /pushify-static.sh 3000');
    expect(dockerfile).toContain('EXPOSE 3000');
    // the final image starts from an empty web root: no "Welcome to nginx!" left behind
    expect(dockerfile).toContain('RUN rm -rf /usr/share/nginx/html/* /etc/nginx/conf.d/*');
    expect(dockerfile).toContain('COPY --from=site /out/html/ /usr/share/nginx/html/');
  });

  it('copies only the configured root directory into the build stage', () => {
    expect(staticBuildpack.generateDockerfile({ port: 80, rootDirectory: 'web' })).toContain('COPY web /src');
  });
});

describe('staticBuildpack.detect', () => {
  it('detects a site in a subfolder, a capitalised Index.html and index.htm', async () => {
    const cases: Array<[Record<string, string>, number]> = [
      [{ 'site/index.html': '' }, 45],
      [{ 'Index.html': '' }, 50],
      [{ 'index.htm': '' }, 50],
      [{ 'pages/about.html': '', 'nginx.conf': '' }, 40],
      [{ 'README.md': '' }, 0],
      [{ 'home.html': '' }, 40],
    ];
    for (const [files, confidence] of cases) {
      await fs.rm(path.join(tmp, 'src'), { recursive: true, force: true });
      const src = await repo(files);
      const result = await staticBuildpack.detect(src, '.');
      expect(result.confidence).toBe(confidence);
    }
  });
});
