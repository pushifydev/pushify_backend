import { describe, it, expect, beforeAll, afterAll, vi, onTestFailed } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { promises as fs, readFileSync } from 'node:fs';
import { promises as dns } from 'node:dns';
import os from 'node:os';
import path from 'node:path';

/**
 * End to end: a real deploy through the real code, to a real server — the e2e box (e2e/). The
 * worker SSHes to root@127.0.0.1, clones, builds with Docker, writes the nginx vhost and gets a
 * certificate from Pebble, then this test talks HTTP(S) to nginx like a visitor would.
 *
 * It exists because the costly bugs lived exactly here, between our code and git / nginx /
 * certbot, where unit tests with a fake SSH can't see: a www domain wiping the apex vhost, a
 * static site serving .git with the clone token, the image's "Welcome to nginx!" as a home page.
 *
 * Runs only with PUSHIFY_E2E=1 (npm run test:e2e). DNS is answered in-process — every fixture
 * domain "points at" 127.0.0.1 — so nothing depends on public DNS.
 */
const E2E = !!process.env.PUSHIFY_E2E;
const SERVER_IP = '127.0.0.1';
const run = Date.now().toString(36);

type Db = typeof import('../db')['db'];
type Schema = typeof import('../db/schema');
let db: Db;
let schema: Schema;
let executeDeploymentJob: typeof import('../workers/deployment.worker')['executeDeploymentJob'];
let loadDeploymentJobById: typeof import('../workers/deployment.worker')['loadDeploymentJobById'];
let userId: string;
let organizationId: string;
let serverId: string;
const tmpDirs: string[] = [];

/** A git repo with these files, committed on main. Returns a file:// URL the worker can clone. */
async function fixtureRepo(files: Record<string, string>, existing?: string): Promise<string> {
  const dir = existing ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'pushify-e2e-repo-')));
  if (!existing) tmpDirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  if (!existing) execSync('git init -q -b main', { cwd: dir });
  execSync('git add -A && git commit -qm "e2e"', { cwd: dir });
  return dir;
}

/** What nginx on the box is actually doing — printed when a test fails. */
function serverState(): string {
  const run = (cmd: string) => {
    try {
      return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return String((error as { stdout?: string; stderr?: string }).stdout ?? '') + String((error as { stderr?: string }).stderr ?? '');
    }
  };
  return [
    '--- ls sites-enabled / conf.d / live certs',
    run('ls -la /etc/nginx/sites-enabled /etc/nginx/conf.d /etc/letsencrypt/live 2>&1'),
    '--- nginx -T (server blocks)',
    run("nginx -T 2>&1 | grep -nE '^# configuration file|server_name|listen|ssl_certificate |return 301|proxy_pass' | head -150"),
    '--- containers',
    run("docker ps -a --format '{{.Names}}  {{.Status}}  {{.Ports}}' 2>&1"),
    '--- port registry',
    run('cat /opt/pushify/port-registry.json 2>&1'),
    '--- tools',
    run('for t in ss nc netstat; do printf "%s: " $t; command -v $t || echo missing; done'),
  ].join('\n');
}

/** GET through nginx on 127.0.0.1, whatever the host name resolves to. */
function request(url: string) {
  const host = new URL(url).hostname;
  const out = execFileSync(
    'curl',
    [
      '-sk', '--max-time', '20',
      '--resolve', `${host}:443:${SERVER_IP}`,
      '--resolve', `${host}:80:${SERVER_IP}`,
      '-w', '\n__STATUS__ %{http_code} %{redirect_url}',
      url,
    ],
    { encoding: 'utf8' }
  );
  const marker = out.lastIndexOf('\n__STATUS__ ');
  const [status, redirect = ''] = out.slice(marker + 12).trim().split(' ');
  return { status: Number(status), body: out.slice(0, marker), redirect };
}

async function createProject(name: string, repoDir: string, domain: string) {
  const slug = `e2e-${name}-${run}`;
  const [project] = await db
    .insert(schema.projects)
    .values({
      organizationId,
      name: slug,
      slug,
      serverId,
      gitRepoUrl: `file://${repoDir}`,
      gitBranch: 'main',
      port: 3000,
      autoDeploy: false,
    })
    .returning();
  await db.insert(schema.domains).values({ projectId: project.id, domain, isPrimary: true });
  return project;
}

/** Queue a deployment the way the API does, then run it the way the worker does. */
async function deploy(projectId: string) {
  const [row] = await db
    .insert(schema.deployments)
    .values({ projectId, status: 'pending', trigger: 'manual', branch: 'main', triggeredById: userId })
    .returning();
  const job = await loadDeploymentJobById(row.id);
  expect(job).not.toBeNull();
  await executeDeploymentJob(job!);

  const done = await db.query.deployments.findFirst({ where: (d, { eq }) => eq(d.id, row.id) });
  if (done?.status !== 'running') {
    // The deploy log is the only useful thing when this fails in CI.
    console.error(`--- deploy ${row.id} ended ${done?.status}: ${done?.errorMessage}\n${done?.buildLogs ?? ''}\n${done?.deployLogs ?? ''}`);
  }
  expect(done?.status).toBe('running');
  return done!;
}

describe.skipIf(!E2E)('deploy to a real server (e2e)', () => {
  beforeAll(async () => {
    ({ db } = await import('../db'));
    schema = await import('../db/schema');
    ({ executeDeploymentJob, loadDeploymentJobById } = await import('../workers/deployment.worker'));
    const { encrypt } = await import('../lib/encryption');

    // Every fixture domain (and its www twin) points at this box.
    const realResolve4 = dns.resolve4.bind(dns);
    vi.spyOn(dns, 'resolve4').mockImplementation((async (host: string) =>
      host.endsWith('.nip.io') ? [SERVER_IP] : realResolve4(host)) as typeof dns.resolve4);

    const [user] = await db
      .insert(schema.users)
      .values({ email: `e2e-${run}@pushify.test`, name: 'E2E', emailVerified: true })
      .returning();
    userId = user.id;
    const [org] = await db.insert(schema.organizations).values({ name: 'E2E', slug: `e2e-${run}` }).returning();
    organizationId = org.id;
    await db.insert(schema.organizationMembers).values({ organizationId, userId, role: 'owner' });

    const keyPath = process.env.PUSHIFY_E2E_SSH_KEY ?? '/root/e2e_key';
    const [server] = await db
      .insert(schema.servers)
      .values({
        organizationId,
        name: 'e2e-box',
        provider: 'self_hosted',
        region: 'local',
        ipv4: SERVER_IP,
        status: 'running',
        setupStatus: 'completed',
        sshPrivateKey: encrypt(readFileSync(keyPath, 'utf8')),
        sshPublicKey: readFileSync(`${keyPath}.pub`, 'utf8'),
      })
      .returning();
    serverId = server.id;
  }, 60_000);

  afterAll(async () => {
    await Promise.all(tmpDirs.map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it(
    'static site: serves the folder nginx.conf points at, apex + www over HTTPS, never .git',
    async () => {
      onTestFailed(() => console.error(serverState()));
      const domain = `static-${run}.127.0.0.1.nip.io`;
      const repo = await fixtureRepo({
        // Written for a VPS, like the real one that showed "Welcome to nginx!"
        'nginx.conf': [
          'server {',
          '    listen 80;',
          `    server_name ${domain};`,
          '    root /var/www/site;',
          '    index index.html;',
          '    location = /privacy { try_files /privacy.html =404; }',
          '}',
          '',
        ].join('\n'),
        'site/index.html': '<!doctype html><title>E2E</title><h1>E2E-STATIC-OK</h1>',
        'site/privacy.html': '<!doctype html><title>Privacy</title>E2E-PRIVACY',
        'README.md': 'not part of the site',
      });
      const project = await createProject('static', repo, domain);

      await deploy(project.id);

      const home = request(`https://${domain}/`);
      expect(home.status).toBe(200);
      expect(home.body).toContain('E2E-STATIC-OK');
      expect(request(`https://${domain}/privacy`).body).toContain('E2E-PRIVACY');

      // Nothing from the repository beyond the site itself
      expect(request(`https://${domain}/.git/config`).status).toBe(404);
      expect(request(`https://${domain}/Dockerfile`).status).toBe(404);
      expect(request(`https://${domain}/nginx.conf`).status).toBe(404);

      // HTTP and the www twin end up on the canonical HTTPS URL
      const plain = request(`http://${domain}/privacy`);
      expect(plain.status).toBe(301);
      expect(plain.redirect).toBe(`https://${domain}/privacy`);
      const www = request(`https://www.${domain}/`);
      expect(www.status).toBe(301);
      expect(www.redirect).toBe(`https://${domain}/`);

      const row = await db.query.domains.findFirst({ where: (d, { eq }) => eq(d.domain, domain) });
      expect(row?.sslStatus).toBe('active');
    },
    600_000
  );

  it('refuses a branch that is a shell command before anything runs on the server', async () => {
    const marker = `/tmp/pushify-e2e-pwned-${run}`;
    const repo = await fixtureRepo({ 'index.html': 'x' });
    // Straight into the database: rows written before the API validated, or a webhook branch
    const [project] = await db
      .insert(schema.projects)
      .values({
        organizationId,
        name: `e2e-inject-${run}`,
        slug: `e2e-inject-${run}`,
        serverId,
        gitRepoUrl: `file://${repo}`,
        gitBranch: `main;touch${'${IFS}'}${marker}`,
        port: 3000,
        autoDeploy: false,
      })
      .returning();
    const [row] = await db
      .insert(schema.deployments)
      .values({ projectId: project.id, status: 'pending', trigger: 'manual', triggeredById: userId })
      .returning();

    await executeDeploymentJob((await loadDeploymentJobById(row.id))!);

    const done = await db.query.deployments.findFirst({ where: (d, { eq }) => eq(d.id, row.id) });
    expect(done?.status).toBe('failed');
    expect(done?.errorMessage).toContain('Refusing to deploy');
    await expect(fs.access(marker)).rejects.toThrow();
  }, 120_000);

  it(
    'node app: builds from package.json, redeploys blue-green, keeps its domain',
    async () => {
      onTestFailed(() => console.error(serverState()));
      const domain = `node-${run}.127.0.0.1.nip.io`;
      const server = (version: string) =>
        [
          "const http = require('http');",
          `http.createServer((req, res) => res.end('E2E-NODE ${version}')).listen(process.env.PORT || 3000);`,
          '',
        ].join('\n');
      const repo = await fixtureRepo({
        'package.json': JSON.stringify(
          { name: 'e2e-node', version: '1.0.0', private: true, scripts: { build: 'echo built', start: 'node server.js' } },
          null,
          2
        ),
        'server.js': server('v1'),
      });
      const project = await createProject('node', repo, domain);

      await deploy(project.id);
      expect(request(`https://${domain}/`).body).toContain('E2E-NODE v1');

      await fixtureRepo({ 'server.js': server('v2') }, repo);
      await deploy(project.id);
      expect(request(`https://${domain}/`).body).toContain('E2E-NODE v2');

      // Blue-green retired the old slot: one app container left
      const running = execSync(`docker ps --filter name=pushify-${project.slug} --format '{{.Names}}'`, { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean);
      expect(running).toHaveLength(1);

      // Hardened for a shared host: no raw sockets (ARP spoofing), no setuid escalation, capped logs
      const hostConfig = JSON.parse(execSync(`docker inspect -f '{{json .HostConfig}}' ${running[0]}`, { encoding: 'utf8' }));
      expect(hostConfig.CapDrop.map((c: string) => c.replace(/^CAP_/, ''))).toContain('NET_RAW');
      expect(hostConfig.SecurityOpt).toContain('no-new-privileges');
      expect(hostConfig.LogConfig).toEqual({ Type: 'json-file', Config: { 'max-file': '3', 'max-size': '10m' } });
    },
    900_000
  );
});
