import { describe, it, expect, beforeAll, afterAll, vi, onTestFailed } from 'vitest';
import { eq as eqOp } from 'drizzle-orm';
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
async function deploy(projectId: string, options: { rollbackFrom?: string } = {}) {
  const [row] = await db
    .insert(schema.deployments)
    .values({
      projectId,
      status: 'pending',
      trigger: options.rollbackFrom ? 'rollback' : 'manual',
      branch: 'main',
      triggeredById: userId,
      rollbackFromDeploymentId: options.rollbackFrom,
    })
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

/** Poll until `check` returns a value (not undefined), or fail with what it last saw. */
async function waitFor<T>(label: string, check: () => Promise<T | undefined>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

/** Run a command on the box; stdout, or undefined when it fails (for polling). */
function tryExec(cmd: string): string | undefined {
  try {
    return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return undefined;
  }
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
    const [org] = await db
      .insert(schema.organizations)
      .values({ name: 'E2E', slug: `e2e-${run}`, planLimitsOverride: { databases: -1 } })
      .returning();
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

      // The daily certificate check reads what the domain serves; 10 days before that expiry the
      // first warning goes out — once. (Pebble's certificates are short-lived: the first check is
      // pinned to a date long before.)
      const { certExpiryService } = await import('../services/cert-expiry.service');
      expect(await certExpiryService.checkDomains({ domainIds: [row!.id], now: new Date('2000-01-01') })).toEqual({ checked: 1, warned: 0 });
      const checkedRow = await db.query.domains.findFirst({ where: (d, { eq }) => eq(d.id, row!.id) });
      expect(checkedRow?.sslExpiresAt).toBeInstanceOf(Date);
      const now = new Date(checkedRow!.sslExpiresAt!.getTime() - 10 * 24 * 60 * 60 * 1000);
      expect(await certExpiryService.checkDomains({ domainIds: [row!.id], now })).toEqual({ checked: 1, warned: 1 });
      expect(await certExpiryService.checkDomains({ domainIds: [row!.id], now })).toEqual({ checked: 1, warned: 0 });
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

      // Monitoring: three failed checks make it "down" (and mail), answering again clears it
      const { appHealthService } = await import('../services/app-health.service');
      const health = async (times = 1) => {
        let status: string = 'unknown';
        for (let i = 0; i < times; i++) {
          const [candidate] = (await appHealthService.candidates()).filter((c) => c.projectId === project.id);
          expect(candidate, 'project should be monitored').toBeTruthy();
          status = await appHealthService.checkProject(candidate, new Date(Date.now() + i * 60_000));
        }
        return status;
      };
      expect(await health()).toBe('up');

      const appContainer = execSync(`docker ps --filter name=pushify-${project.slug} --format '{{.Names}}'`, { encoding: 'utf8' }).trim();
      execSync(`docker stop ${appContainer}`);
      expect(await health(2)).toBe('up'); // one or two failures are not an outage
      expect(await health()).toBe('down');
      const downState = await db.query.projectHealthState.findFirst({ where: (h, { eq }) => eq(h.projectId, project.id) });
      expect(downState?.downSince).toBeInstanceOf(Date);
      expect(downState?.notifiedAt).toBeInstanceOf(Date);

      execSync(`docker start ${appContainer}`);
      await waitFor('the app to answer again', async () => ((await health()) === 'up' ? true : undefined), 60_000);
      const upState = await db.query.projectHealthState.findFirst({ where: (h, { eq }) => eq(h.projectId, project.id) });
      expect(upState?.status).toBe('up');
      expect(upState?.downSince).toBeNull();

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
  it(
    'pushify.yaml app: volume survives redeploy and rollback, worker and cron exist, a domain added later works',
    async () => {
      onTestFailed(() => console.error(serverState()));
      const domain = `vol-${run}.127.0.0.1.nip.io`;
      // Counts requests in a file on the volume, so a lost volume shows up as a reset count.
      const server = (version: string) =>
        [
          "const http = require('http');",
          "const fs = require('fs');",
          "http.createServer((req, res) => {",
          "  let hits = 0;",
          "  try { hits = Number(fs.readFileSync('/data/hits', 'utf8')) || 0; } catch {}",
          "  hits += 1;",
          "  fs.writeFileSync('/data/hits', String(hits));",
          `  res.end('E2E-VOL ${version} hits=' + hits);`,
          '}).listen(process.env.PORT || 3000);',
          '',
        ].join('\n');
      const repo = await fixtureRepo({
        'package.json': JSON.stringify(
          { name: 'e2e-vol', version: '1.0.0', private: true, scripts: { build: 'echo built', start: 'node server.js' } },
          null,
          2
        ),
        'server.js': server('v1'),
        'worker.js': "console.log('worker up'); setInterval(() => {}, 60000);\n",
        'pushify.yaml': [
          'volumes:',
          '  - name: data',
          '    path: /data',
          'workers:',
          '  - name: queue',
          '    command: node worker.js',
          'cron:',
          '  - name: tick',
          '    schedule: "*/5 * * * *"',
          '    command: node -e "console.log(1)"',
          '',
        ].join('\n'),
      });
      const project = await createProject('vol', repo, domain);

      const first = await deploy(project.id);
      expect(request(`https://${domain}/`).body).toBe('E2E-VOL v1 hits=1');
      expect(request(`https://${domain}/`).body).toBe('E2E-VOL v1 hits=2');

      // Declared in pushify.yaml, created by the deploy
      const workers = execSync(`docker ps --filter name=pushify-${project.slug}-worker- --format '{{.Names}}'`, { encoding: 'utf8' });
      expect(workers).toContain(`pushify-${project.slug}-worker-queue`);
      const cron = await db.query.scheduledTasks.findFirst({ where: (t, { eq }) => eq(t.projectId, project.id) });
      expect(cron?.name).toBe('tick');

      // New code, same data
      await fixtureRepo({ 'server.js': server('v2') }, repo);
      await deploy(project.id);
      expect(request(`https://${domain}/`).body).toBe('E2E-VOL v2 hits=3');

      // Back to v1's image — still the same data
      await deploy(project.id, { rollbackFrom: first.id });
      expect(request(`https://${domain}/`).body).toBe('E2E-VOL v1 hits=4');

      // A domain added after the fact: verify wires nginx + certificate without a redeploy
      const late = `late-${run}.127.0.0.1.nip.io`;
      const [lateRow] = await db.insert(schema.domains).values({ projectId: project.id, domain: late }).returning();
      const { domainService } = await import('../services/domain.service');
      await domainService.verify(lateRow.id, project.id, organizationId, userId, 'en');
      expect(request(`https://${late}/`).body).toBe('E2E-VOL v1 hits=5');
      expect(request(`https://${domain}/`).body).toBe('E2E-VOL v1 hits=6');
      const lateStatus = await db.query.domains.findFirst({ where: (d, { eq }) => eq(d.id, lateRow.id) });
      expect(lateStatus?.sslStatus).toBe('active');
    },
    900_000
  );

  it(
    'managed postgres: a linked app reaches it by name, backups restore (twice), password reset + redeploy',
    async () => {
      onTestFailed(() => console.error(serverState()));
      const { databaseService } = await import('../services/database.service');
      const { databaseBackupService } = await import('../services/database-backup.service');

      const created = await databaseService.create(
        organizationId,
        userId,
        { name: `app-${run}`, type: 'postgresql', serverId },
        'en'
      );
      const database = await waitFor('the database container', async () => {
        const row = await db.query.databases.findFirst({ where: (d, { eq }) => eq(d.id, created.id) });
        if (row?.status === 'error') throw new Error(`Provisioning failed: ${row.statusMessage}`);
        return row?.status === 'running' ? row : undefined;
      });

      // Only on loopback, on the database network, hardened like app containers
      const dbHost = JSON.parse(execSync(`docker inspect -f '{{json .HostConfig}}' ${database.containerName}`, { encoding: 'utf8' }));
      expect(dbHost.PortBindings['5432/tcp'][0].HostIp).toBe('127.0.0.1');
      expect(dbHost.NetworkMode).toBe('pushify');
      expect(dbHost.SecurityOpt).toContain('no-new-privileges');

      const domain = `db-${run}.127.0.0.1.nip.io`;
      const repo = await fixtureRepo({
        'package.json': JSON.stringify(
          {
            name: 'e2e-db',
            version: '1.0.0',
            private: true,
            scripts: { build: 'echo built', start: 'node server.js' },
            dependencies: { pg: '8.13.1' },
          },
          null,
          2
        ),
        'server.js': [
          "const http = require('http');",
          "const { Pool } = require('pg');",
          'const pool = new Pool({ connectionString: process.env.DATABASE_URL, idleTimeoutMillis: 1000 });',
          'async function handle(req) {',
          "  const url = new URL(req.url, 'http://x');",
          "  if (url.pathname === '/add' || url.pathname === '/clear') await pool.query('CREATE TABLE IF NOT EXISTS notes (id serial primary key, body text not null)');",
          "  if (url.pathname === '/add') await pool.query('INSERT INTO notes (body) VALUES ($1)', [url.searchParams.get('body')]);",
          "  if (url.pathname === '/clear') await pool.query('DELETE FROM notes');",
          "  const { rows } = await pool.query('SELECT body FROM notes ORDER BY id');",
          "  return 'E2E-DB ' + rows.map((r) => r.body).join(',');",
          '}',
          'http.createServer((req, res) => handle(req).then((body) => res.end(body), (err) => {',
          "  res.statusCode = 500; res.end('E2E-DB-ERROR ' + err.message);",
          '})).listen(process.env.PORT || 3000);',
          '',
        ].join('\n'),
      });
      const project = await createProject('db', repo, domain);
      await databaseService.connectToProject(database.id, organizationId, userId, { projectId: project.id }, 'en');

      const read = async (path = '/') =>
        waitFor(`the app at ${path}`, async () => {
          const res = request(`https://${domain}${path}`);
          return res.status === 200 ? res.body : undefined;
        }, 60_000);

      await deploy(project.id);
      // DATABASE_URL was injected with the container's name — the public address wouldn't work
      const appContainer = execSync(`docker ps --filter name=pushify-${project.slug} --format '{{.Names}}'`, { encoding: 'utf8' }).trim();
      const appEnv = execSync(`docker inspect -f '{{json .Config.Env}}' ${appContainer}`, { encoding: 'utf8' });
      expect(appEnv).toContain(`@${database.containerName}:5432/`);

      await read('/add?body=one');
      expect(await read('/add?body=two')).toBe('E2E-DB one,two');

      // A second project connected read-only sees the same data and can't change it
      const roDomain = `db-ro-${run}.127.0.0.1.nip.io`;
      const roProject = await createProject('db-ro', repo, roDomain);
      await databaseService.connectToProject(database.id, organizationId, userId, { projectId: roProject.id, permissions: 'readonly' }, 'en');
      await deploy(roProject.id);
      const roContainer = execSync(`docker ps --filter name=pushify-${roProject.slug} --format '{{.Names}}'`, { encoding: 'utf8' }).trim();
      expect(execSync(`docker inspect -f '{{json .Config.Env}}' ${roContainer}`, { encoding: 'utf8' })).toContain(`${database.username}_ro:`);
      const roRead = () =>
        waitFor('the read-only app', async () => {
          const res = request(`https://${roDomain}/`);
          return res.status === 200 ? res.body : undefined;
        }, 60_000);
      expect(await roRead()).toBe('E2E-DB one,two');
      const roWrite = request(`https://${roDomain}/add?body=nope`);
      expect(roWrite.status).toBe(500);
      expect(roWrite.body).toMatch(/read-only|permission denied/);

      const backup = await databaseBackupService.createBackup(database.id, organizationId, userId, 'en');
      await waitFor('the backup', async () => {
        const row = await db.query.databaseBackups.findFirst({ where: (b, { eq }) => eq(b.id, backup.id) });
        if (row?.status === 'failed') throw new Error(`Backup failed: ${row.errorMessage}`);
        return row?.status === 'completed' ? row : undefined;
      });

      const restore = async () => {
        await databaseBackupService.restoreBackup(database.id, backup.id, organizationId, userId, 'en');
        const row = await waitFor('the restore', async () => {
          const current = await db.query.databaseBackups.findFirst({ where: (b, { eq }) => eq(b.id, backup.id) });
          return current && current.status !== 'restoring' ? current : undefined;
        });
        expect(row.errorMessage).toBeNull();
        expect(row.status).toBe('completed');
      };

      // Rows deleted and added after the backup: a restore brings back exactly the backup
      await read('/clear');
      expect(await read('/add?body=three')).toBe('E2E-DB three');
      await restore();
      expect(await read()).toBe('E2E-DB one,two');
      // …and the read-only user still has access to the restored tables
      expect(await roRead()).toBe('E2E-DB one,two');

      // The same backup restores again (it used to end up 'restored' and locked)
      expect(await read('/add?body=four')).toBe('E2E-DB one,two,four');
      await restore();
      expect(await read()).toBe('E2E-DB one,two');

      // A new password takes effect in the database and reaches the app on the next deploy
      const { password } = await databaseService.resetPassword(database.id, organizationId, userId, 'en');
      expect(
        tryExec(`docker exec -e PGPASSWORD='${password}' ${database.containerName} psql -h 127.0.0.1 -U ${database.username} -d ${database.databaseName} -tAc 'select 1'`)
      ).toBe('1');
      await deploy(project.id);
      expect(await read()).toBe('E2E-DB one,two');
      // The read-only user has a password of its own: untouched by the reset
      expect(await roRead()).toBe('E2E-DB one,two');
    },
    900_000
  );

  // Postgres runs above with an app; the others here without one. CI runs Redis (small image);
  // PUSHIFY_E2E_DB_ENGINES=redis,mysql,mongodb covers the rest.
  const engines = (process.env.PUSHIFY_E2E_DB_ENGINES ?? 'redis').split(',').map((e) => e.trim()).filter(Boolean);
  const engineClient: Record<string, {
    ready: (c: string, pw: string, user: string, dbName: string) => string;
    write: (c: string, pw: string, user: string, dbName: string, value: string) => string;
    read: (c: string, pw: string, user: string, dbName: string) => string;
  }> = {
    redis: {
      ready: (c, pw) => `docker exec -e REDISCLI_AUTH=${pw} ${c} redis-cli PING`,
      write: (c, pw, _u, _d, v) => `docker exec -e REDISCLI_AUTH=${pw} ${c} redis-cli SET e2e ${v}`,
      read: (c, pw) => `docker exec -e REDISCLI_AUTH=${pw} ${c} redis-cli GET e2e`,
    },
    mysql: {
      ready: (c, pw, u, d) => `docker exec -e MYSQL_PWD=${pw} ${c} mysql -u ${u} ${d} -NBe 'select 1'`,
      write: (c, pw, u, d, v) =>
        `docker exec -e MYSQL_PWD=${pw} ${c} mysql -u ${u} ${d} -e "CREATE TABLE IF NOT EXISTS e2e (v varchar(20)); DELETE FROM e2e; INSERT INTO e2e VALUES ('${v}')"`,
      read: (c, pw, u, d) => `docker exec -e MYSQL_PWD=${pw} ${c} mysql -u ${u} ${d} -NBe 'select group_concat(v) from e2e'`,
    },
    mongodb: {
      ready: (c, pw, u) => `docker exec ${c} mongosh --quiet -u ${u} -p ${pw} --authenticationDatabase admin --eval 'db.runCommand({ping:1}).ok'`,
      write: (c, pw, u, d, v) =>
        `docker exec ${c} mongosh --quiet -u ${u} -p ${pw} --authenticationDatabase admin ${d} --eval 'db.e2e.deleteMany({}); db.e2e.insertOne({v:"${v}"})'`,
      read: (c, pw, u, d) =>
        `docker exec ${c} mongosh --quiet -u ${u} -p ${pw} --authenticationDatabase admin ${d} --eval 'db.e2e.find().toArray().map((x) => x.v).join(",")'`,
    },
  };

  for (const engine of engines.filter((e) => e in engineClient)) {
    it(
      `managed ${engine}: backup + restore, password reset survives a restart`,
      async () => {
        onTestFailed(() => console.error(serverState()));
        const { databaseService } = await import('../services/database.service');
        const { databaseBackupService } = await import('../services/database-backup.service');
        const client = engineClient[engine];

        const created = await databaseService.create(
          organizationId,
          userId,
          { name: `${engine}-${run}`, type: engine as 'redis' | 'mysql' | 'mongodb', serverId },
          'en'
        );
        const database = await waitFor(`the ${engine} container`, async () => {
          const row = await db.query.databases.findFirst({ where: (d, { eq }) => eq(d.id, created.id) });
          if (row?.status === 'error') throw new Error(`Provisioning failed: ${row.statusMessage}`);
          return row?.status === 'running' ? row : undefined;
        });
        const details = await databaseService.getConnectionDetails(database.id, organizationId, userId, 'en');
        const c = database.containerName!;
        const u = database.username;
        const d = database.databaseName;
        await waitFor(`${engine} to accept connections`, async () => tryExec(client.ready(c, details.password, u, d)));

        execSync(client.write(c, details.password, u, d, 'before'));
        const backup = await databaseBackupService.createBackup(database.id, organizationId, userId, 'en');
        await waitFor('the backup', async () => {
          const row = await db.query.databaseBackups.findFirst({ where: (b, { eq }) => eq(b.id, backup.id) });
          if (row?.status === 'failed') throw new Error(`Backup failed: ${row.errorMessage}`);
          return row?.status === 'completed' ? row : undefined;
        });

        execSync(client.write(c, details.password, u, d, 'after'));
        await databaseBackupService.restoreBackup(database.id, backup.id, organizationId, userId, 'en');
        const restored = await waitFor('the restore', async () => {
          const row = await db.query.databaseBackups.findFirst({ where: (b, { eq }) => eq(b.id, backup.id) });
          return row && row.status !== 'restoring' ? row : undefined;
        });
        expect(restored.errorMessage).toBeNull();
        const afterRestore = await waitFor('the restored data', async () => tryExec(client.read(c, details.password, u, d)));
        expect(afterRestore).toBe('before');

        // Read-only access: reads work, writes don't — and Redis has no such mode
        if (engine === 'redis') {
          await expect(databaseService.ensureReadonlyUser(database.id)).rejects.toThrow(/Redis/);
        } else {
          const ro = await databaseService.ensureReadonlyUser(database.id);
          expect(await waitFor('the read-only user', async () => tryExec(client.read(c, ro.password, ro.username, d)))).toBe('before');
          expect(tryExec(client.write(c, ro.password, ro.username, d, 'hacked'))).toBeUndefined();
          expect(tryExec(client.read(c, details.password, u, d))).toBe('before');
        }

        const { password } = await databaseService.resetPassword(database.id, organizationId, userId, 'en');
        await waitFor(`${engine} with the new password`, async () => tryExec(client.ready(c, password, u, d)));
        execSync(`docker restart ${c}`);
        await waitFor(`${engine} with the new password after a restart`, async () => tryExec(client.ready(c, password, u, d)));
        expect(tryExec(client.read(c, password, u, d))).toBe('before');
      },
      600_000
    );
  }

  it(
    "own server: an app without a domain keeps its <server-ip>:<port> URL across deploys",
    async () => {
      onTestFailed(() => console.error(serverState()));
      const server = (version: string) =>
        ["const http = require('http');", `http.createServer((req, res) => res.end('E2E-OWN ${version}')).listen(process.env.PORT || 3000);`, ''].join('\n');
      const repo = await fixtureRepo({
        'package.json': JSON.stringify(
          { name: 'e2e-own', version: '1.0.0', private: true, scripts: { build: 'echo built', start: 'node server.js' } },
          null,
          2
        ),
        'server.js': server('v1'),
      });
      const project = await createProject('own', repo, `unused-own-${run}.127.0.0.1.nip.io`);
      await db.delete(schema.domains).where(eqOp(schema.domains.projectId, project.id));

      const publicPort = () =>
        (JSON.parse(readFileSync('/opt/pushify/port-registry.json', 'utf8')).assignments as Array<{ port: number; projectSlug: string }>).find(
          (a) => a.projectSlug === `${project.slug}:public`
        )?.port;
      const boxIp = execSync(`hostname -I | awk '{print $1}'`, { encoding: 'utf8' }).trim();
      const get = (port: number) => tryExec(`curl -s --max-time 10 http://${boxIp}:${port}/`);

      await deploy(project.id);
      const port = publicPort()!;
      expect(port).toBeGreaterThan(0);
      expect(get(port)).toBe('E2E-OWN v1');

      // Blue-green moves the container to another port; the URL stays
      await fixtureRepo({ 'server.js': server('v2') }, repo);
      await deploy(project.id);
      expect(publicPort()).toBe(port);
      expect(get(port)).toBe('E2E-OWN v2');

      const name = execSync(`docker ps --filter name=pushify-${project.slug} --format '{{.Names}}'`, { encoding: 'utf8' }).trim();
      const bindings = JSON.parse(execSync(`docker inspect -f '{{json .HostConfig.PortBindings}}' ${name}`, { encoding: 'utf8' }));
      expect(Object.values(bindings as Record<string, Array<{ HostIp: string }>>)[0][0].HostIp).toBe('127.0.0.1');
    },
    600_000
  );

  // Last on purpose: it turns the box into a shared runner, and its firewall rules stay for the run.
  it(
    'shared runner: apps are reachable through nginx only, not from each other, the host or the public port',
    async () => {
      onTestFailed(() => console.error(serverState(), '\n--- iptables\n', tryExec('iptables -S PUSHIFY-FWD; iptables -S PUSHIFY-IN; iptables -S DOCKER-USER')));
      const { env } = await import('../config/env');
      const previousRunners = env.PUSHIFY_RUNNER_SERVER_IDS;
      env.PUSHIFY_RUNNER_SERVER_IDS = serverId;
      // A service on the host, on all interfaces — what a tenant would go looking for
      const net = await import('node:net');
      const hostService = net.createServer((socket) => socket.end('host'));
      await new Promise<void>((resolve) => hostService.listen(0, '0.0.0.0', resolve));
      const hostServicePort = (hostService.address() as { port: number }).port;
      try {
        // Answers /probe?host=&port= with open/closed — what a hostile tenant would try
        const repo = await fixtureRepo({
          'package.json': JSON.stringify(
            { name: 'e2e-iso', version: '1.0.0', private: true, scripts: { build: 'echo built', start: 'node server.js' } },
            null,
            2
          ),
          'server.js': [
            "const http = require('http');",
            "const net = require('net');",
            'const probe = (host, port) => new Promise((resolve) => {',
            '  const socket = net.connect({ host, port: Number(port), timeout: 3000 });',
            "  socket.on('connect', () => { socket.destroy(); resolve('open'); });",
            "  socket.on('timeout', () => { socket.destroy(); resolve('closed'); });",
            "  socket.on('error', () => resolve('closed'));",
            '});',
            'http.createServer(async (req, res) => {',
            "  const url = new URL(req.url, 'http://x');",
            "  if (url.pathname === '/probe') return res.end(await probe(url.searchParams.get('host'), url.searchParams.get('port')));",
            "  res.end('E2E-ISO');",
            '}).listen(process.env.PORT || 3000);',
            '',
          ].join('\n'),
        });
        const domainA = `iso-a-${run}.127.0.0.1.nip.io`;
        const domainB = `iso-b-${run}.127.0.0.1.nip.io`;
        const a = await createProject('iso-a', repo, domainA);
        const b = await createProject('iso-b', repo, domainB);
        await deploy(a.id);
        await deploy(b.id);

        // Visitors still get in, through nginx
        expect(request(`https://${domainA}/`).body).toBe('E2E-ISO');
        expect(request(`https://${domainB}/`).body).toBe('E2E-ISO');
        // …but a name nginx has no site for gets nothing — not the first customer site it loaded
        const stranger = `nosuchsite-${run}.example.com`;
        expect(tryExec(`curl -sk --max-time 10 --resolve ${stranger}:443:${SERVER_IP} https://${stranger}/`)).toBeUndefined();

        const container = (slug: string) =>
          execSync(`docker ps --filter name=pushify-${slug} --format '{{.Names}}'`, { encoding: 'utf8' }).trim();
        const containerA = container(a.slug);
        const containerB = container(b.slug);
        const hostConfigB = JSON.parse(execSync(`docker inspect -f '{{json .HostConfig}}' ${containerB}`, { encoding: 'utf8' }));
        const bindingB = Object.values(hostConfigB.PortBindings as Record<string, Array<{ HostIp: string; HostPort: string }>>)[0][0];
        // Published on loopback: no raw <server-ip>:<port> way around nginx
        expect(bindingB.HostIp).toBe('127.0.0.1');
        expect(containerA).not.toBe('');

        const ipB = execSync(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${containerB}`, { encoding: 'utf8' }).trim();
        // Apps on a runner run on their own network; its gateway is the host
        const networks = execSync(`docker inspect -f '{{json .NetworkSettings.Networks}}' ${containerB}`, { encoding: 'utf8' });
        expect(Object.keys(JSON.parse(networks))).toEqual(['pushify-apps']);
        const gateway = execSync(`docker network inspect pushify-apps -f '{{(index .IPAM.Config 0).Gateway}}'`, { encoding: 'utf8' }).trim();
        const probe = (host: string, port: number | string) => request(`https://${domainA}/probe?host=${host}&port=${port}`).body;

        expect(probe(ipB, 3000)).toBe('closed'); // another tenant's container
        expect(probe(gateway, 22)).toBe('closed'); // the host's sshd
        expect(probe(gateway, hostServicePort)).toBe('closed'); // any other service on the host
        expect(probe(gateway, bindingB.HostPort)).toBe('closed'); // another app's host port
        expect(probe(gateway, 443)).toBe('open'); // the host's nginx (an app calling its own URL)
        expect(probe('1.1.1.1', 443)).toBe('open'); // the internet

        // Builds run on Docker's default bridge: the same limits apply while they run. The build
        // step below probes and writes what it could reach; the app then serves that file.
        const buildGateway = execSync(`docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}'`, { encoding: 'utf8' }).trim();
        // A neighbour on the default bridge (reachable from build steps without the rules)
        execSync(
          `docker run -d --name pushify-e2e-neighbour-${run} node:20-bookworm-slim node -e "require('net').createServer((s) => s.end('hi')).listen(7777)"`
        );
        const neighbourIp = execSync(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pushify-e2e-neighbour-${run}`, { encoding: 'utf8' }).trim();
        const buildRepo = await fixtureRepo({
          'package.json': JSON.stringify(
            { name: 'e2e-iso-build', version: '1.0.0', private: true, scripts: { build: 'node probe.js', start: 'node server.js' } },
            null,
            2
          ),
          'targets.json': JSON.stringify({ gateway: buildGateway, hostPort: hostServicePort, neighbour: neighbourIp }),
          'probe.js': [
            "const net = require('net');",
            "const fs = require('fs');",
            "const targets = JSON.parse(fs.readFileSync('targets.json', 'utf8'));",
            'const probe = (host, port) => new Promise((resolve) => {',
            '  const socket = net.connect({ host, port, timeout: 3000 });',
            "  socket.on('connect', () => { socket.destroy(); resolve('open'); });",
            "  socket.on('timeout', () => { socket.destroy(); resolve('closed'); });",
            "  socket.on('error', () => resolve('closed'));",
            '});',
            '(async () => {',
            '  const result = {',
            '    hostService: await probe(targets.gateway, targets.hostPort),',
            '    neighbour: await probe(targets.neighbour, 7777),',
            "    internet: await probe('1.1.1.1', 443),",
            '  };',
            "  fs.writeFileSync('probe-result.json', JSON.stringify(result));",
            '})();',
            '',
          ].join('\n'),
          'server.js': [
            "const http = require('http');",
            "const fs = require('fs');",
            "http.createServer((req, res) => res.end(fs.readFileSync('probe-result.json'))).listen(process.env.PORT || 3000);",
            '',
          ].join('\n'),
        });
        const buildDomain = `iso-build-${run}.127.0.0.1.nip.io`;
        const buildProject = await createProject('iso-build', buildRepo, buildDomain);
        await deploy(buildProject.id);
        expect(JSON.parse(request(`https://${buildDomain}/`).body)).toEqual({ hostService: 'closed', neighbour: 'closed', internet: 'open' });

        // A marketplace app with its own database runs on a network of its own: the app reaches
        // its database there, and nothing more than any other app.
        const mkNet = `pushify-e2e-mk-${run}`;
        execSync(`docker network create ${mkNet}`);
        execSync(
          `docker run -d --name pushify-e2e-mk-db-${run} --network ${mkNet} node:20-bookworm-slim node -e "require('net').createServer((s) => s.end('db')).listen(5432)"`
        );
        const mkDbIp = execSync(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pushify-e2e-mk-db-${run}`, { encoding: 'utf8' }).trim();
        const mkGateway = execSync(`docker network inspect ${mkNet} -f '{{(index .IPAM.Config 0).Gateway}}'`, { encoding: 'utf8' }).trim();
        const mkProbe = [
          "const net = require('net');",
          'const probe = (host, port) => new Promise((resolve) => {',
          '  const socket = net.connect({ host, port, timeout: 3000 });',
          "  socket.on('connect', () => { socket.destroy(); resolve('open'); });",
          "  socket.on('timeout', () => { socket.destroy(); resolve('closed'); });",
          "  socket.on('error', () => resolve('closed'));",
          '});',
          '(async () => console.log(JSON.stringify({',
          `  ownDatabase: await probe('${mkDbIp}', 5432),`,
          `  hostService: await probe('${mkGateway}', ${hostServicePort}),`,
          `  neighbour: await probe('${neighbourIp}', 7777),`,
          "  internet: await probe('1.1.1.1', 443),",
          '})))();',
        ].join('\n');
        const mkResult = execFileSync(
          'docker',
          ['run', '--rm', '--name', `pushify-e2e-mk-app-${run}`, '--network', mkNet, 'node:20-bookworm-slim', 'node', '-e', mkProbe],
          { encoding: 'utf8' }
        );
        expect(JSON.parse(mkResult.trim())).toEqual({ ownDatabase: 'open', hostService: 'closed', neighbour: 'closed', internet: 'open' });

        // No domain (and no wildcard certificate for an auto subdomain): <server-ip>:<port> is the
        // app's only URL. nginx holds that port and forwards to whichever container is current,
        // so the URL survives deploys (it used to flip with every blue-green switch) and the
        // container itself stays on loopback.
        const boxIp = execSync(`hostname -I | awk '{print $1}'`, { encoding: 'utf8' }).trim();
        const get = (port: number) => tryExec(`curl -s --max-time 10 http://${boxIp}:${port}/`);
        const registry = () =>
          JSON.parse(readFileSync('/opt/pushify/port-registry.json', 'utf8')).assignments as Array<{ port: number; projectSlug: string }>;
        const publicPortOf = (slug: string) => registry().find((a) => a.projectSlug === `${slug}:public`)?.port;
        const hostIpOf = (name: string) =>
          Object.values(
            JSON.parse(execSync(`docker inspect -f '{{json .HostConfig.PortBindings}}' ${name}`, { encoding: 'utf8' })) as Record<
              string,
              Array<{ HostIp: string; HostPort: string }>
            >
          )[0][0].HostIp;
        const domainless = async (name: string) => {
          const project = await createProject(name, repo, `unused-${name}-${run}.127.0.0.1.nip.io`);
          await db.delete(schema.domains).where(eqOp(schema.domains.projectId, project.id));
          return project;
        };

        const c = await domainless('iso-c');
        await deploy(c.id);
        const portC = publicPortOf(c.slug)!;
        expect(portC).toBeGreaterThan(0);
        expect(get(portC)).toBe('E2E-ISO');
        expect(hostIpOf(container(c.slug))).toBe('127.0.0.1');
        await deploy(c.id);
        expect(publicPortOf(c.slug)).toBe(portC);
        expect(get(portC)).toBe('E2E-ISO');
        const ipC = execSync(`docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' ${container(c.slug)}`, { encoding: 'utf8' }).trim();
        expect(probe(ipC, 3000)).toBe('closed');

        // Deployed before the proxy existed — its container publishes the port itself: that port
        // (the URL people use) becomes the public port, and the container moves to loopback.
        const d = await domainless('iso-d');
        await deploy(d.id);
        execSync(
          `rm -f /etc/nginx/sites-enabled/pushify-${d.slug}.port /etc/nginx/sites-available/pushify-${d.slug}.port && nginx -s reload && ` +
            `docker rm -f $(docker ps -aq --filter name=pushify-${d.slug}-) && ` +
            `docker run -d --name pushify-${d.slug}-green --network pushify-apps -p 0.0.0.0:3990:3000 -e PORT=3000 pushify-${d.slug}:latest`
        );
        const legacy = registry()
          .filter((a) => !a.projectSlug.startsWith(d.slug))
          .concat([{ port: 3990, projectSlug: d.slug, assignedAt: new Date().toISOString() } as never]);
        await fs.writeFile('/opt/pushify/port-registry.json', JSON.stringify({ assignments: legacy }));
        await waitFor('the legacy container', async () => (get(3990) === 'E2E-ISO' ? true : undefined), 30_000);
        await deploy(d.id);
        expect(publicPortOf(d.slug)).toBe(3990);
        expect(get(3990)).toBe('E2E-ISO');
        expect(hostIpOf(container(d.slug))).toBe('127.0.0.1');
      } finally {
        env.PUSHIFY_RUNNER_SERVER_IDS = previousRunners;
        hostService.close();
        tryExec(`docker rm -f pushify-e2e-neighbour-${run} pushify-e2e-mk-db-${run}`);
        tryExec(`docker network rm pushify-e2e-mk-${run}`);
      }
    },
    600_000
  );
});
