import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { domains } from '../db/schema/projects';
import { SSHClient } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { buildImage, runContainer, checkDocker, getImageId, tagImage, cleanupOldImages, runContainerFromImage, imageExists, blueGreenDeploy, completeBlueGreenSwitch } from './remote-docker';
import { addSite, addAutoSubdomainSite, reloadNginx, requestSSLCertificate } from './nginx-manager';
import {
  applyCalcomEnvDefaults,
  getCalcomExtraHost,
  getCalcomAllowedHostPlaceholder,
} from '../marketplace/helpers';
import { buildCalcomImageScript, calcomImageTag } from '../marketplace/calcom-image';
import { getOrAssignPort } from './port-manager';
import { generateDockerfile } from './dockerfile';
import { normalizeRootDirectory } from '../lib/normalize-root-directory';
import { checkServerDiskSpace } from '../lib/server-disk-check';
import { domainService } from '../services/domain.service';
import path from 'path';

export interface RemoteDeploymentConfig {
  serverId: string;
  projectId: string;
  projectSlug: string;
  deploymentId: string; // For image tagging
  repoUrl: string;
  branch: string;
  commitHash: string;
  port: number;
  envVars: Record<string, string>;
  buildCommand?: string;
  startCommand?: string;
  installCommand?: string;
  rootDirectory?: string;
  dockerfilePath?: string;
  outputDirectory?: string;
  framework?: string;
  /** From local/remote buildpack detection */
  buildpackId?: string;
  accessToken?: string;
  onProgress: (message: string) => void;
  /** e.g. `-pr-42` for preview deployments (separate container/image from production) */
  deploySuffix?: string;
  // Marketplace fields
  marketplace?: {
    id?: string;
    dockerImage?: string;
    dockerCommand?: string;
    volumes?: string[];
    requiresDatabase?: { type: string; version?: string };
    // Compose deployment fields
    deploymentType?: 'single-container' | 'docker-compose';
    composeFile?: string;
    composePublicService?: string;
    composePublicPort?: number;
    extraFiles?: Record<string, string>;
    postDeploySql?: string;
    postDeployShell?: string;
  };
}

export interface RemoteDeploymentResult {
  success: boolean;
  deploymentUrl?: string;
  containerPort?: number;
  dockerImageId?: string; // Docker image ID for rollback
  error?: string;
}

/**
 * Open a TCP port in the server's local firewall so the deployed app is reachable.
 *
 * Deploys connect as root, so the firewall tools are invoked directly with a `sudo`
 * fallback only for the rare non-root case. This is the difference that made BYOS servers
 * fail while Hetzner worked: the Hetzner image we provision always has `sudo` + an enabled
 * `ufw`, but a user's own server may have no `sudo` (minimal root images) or use
 * firewalld/iptables — a hardcoded `sudo ufw ...` fails there and silently leaves the port
 * closed. We detect the available manager and, if none is found locally, tell the user to
 * open the port in their cloud provider's firewall / security group (which we can't reach
 * over SSH).
 */
export async function openFirewallPort(
  ssh: SSHClient,
  port: number,
  onProgress: (message: string) => void,
): Promise<void> {
  onProgress(`🔓 Opening firewall port ${port}...`);

  const script =
    `if command -v ufw >/dev/null 2>&1; then ` +
    `(ufw allow ${port}/tcp 2>&1 || sudo ufw allow ${port}/tcp 2>&1); ` +
    `(ufw reload 2>&1 || sudo ufw reload 2>&1) >/dev/null 2>&1; ` +
    `echo PUSHIFY_FW=ufw; ` +
    `elif command -v firewall-cmd >/dev/null 2>&1; then ` +
    `(firewall-cmd --permanent --add-port=${port}/tcp 2>&1 || sudo firewall-cmd --permanent --add-port=${port}/tcp 2>&1); ` +
    `(firewall-cmd --reload 2>&1 || sudo firewall-cmd --reload 2>&1) >/dev/null 2>&1; ` +
    `echo PUSHIFY_FW=firewalld; ` +
    `elif command -v iptables >/dev/null 2>&1; then ` +
    `(iptables -C INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport ${port} -j ACCEPT 2>&1 || sudo iptables -I INPUT -p tcp --dport ${port} -j ACCEPT 2>&1); ` +
    `echo PUSHIFY_FW=iptables; ` +
    `else echo PUSHIFY_FW=none; fi`;

  const result = await ssh.exec(script);
  const out = `${result.stdout}\n${result.stderr}`;

  if (out.includes('PUSHIFY_FW=ufw')) {
    onProgress(`✅ Firewall port ${port} opened (ufw)`);
  } else if (out.includes('PUSHIFY_FW=firewalld')) {
    onProgress(`✅ Firewall port ${port} opened (firewalld)`);
  } else if (out.includes('PUSHIFY_FW=iptables')) {
    onProgress(`✅ Firewall port ${port} opened (iptables)`);
  } else {
    onProgress(
      `ℹ️ No local firewall manager (ufw/firewalld/iptables) detected — the OS is not blocking port ${port}. ` +
      `If the site is not reachable externally, open TCP port ${port} in your cloud provider's firewall / security group.`,
    );
  }
}

/**
 * Get server details and establish SSH connection
 */
async function getServerAndConnect(serverId: string): Promise<{
  server: typeof servers.$inferSelect;
  ssh: SSHClient;
}> {
  // Get server from database
  const server = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });

  if (!server) {
    throw new Error('Server not found');
  }

  if (server.status !== 'running') {
    throw new Error(`Server is not running (status: ${server.status})`);
  }

  if (server.setupStatus !== 'completed') {
    throw new Error(`Server setup is not completed (status: ${server.setupStatus})`);
  }

  if (!server.ipv4) {
    throw new Error('Server has no IP address');
  }

  if (!server.sshPrivateKey) {
    throw new Error('Server has no SSH private key configured');
  }

  // Decrypt SSH private key
  const privateKey = decrypt(server.sshPrivateKey);

  // Create SSH connection
  const ssh = new SSHClient();
  await ssh.connect({
    host: server.ipv4,
    port: 22,
    username: 'root',
    privateKey,
  });

  return { server, ssh };
}

/**
 * Get primary domain for a project
 */
async function getPrimaryDomain(projectId: string): Promise<string | null> {
  const domain = await db.query.domains.findFirst({
    where: eq(domains.projectId, projectId),
    orderBy: (domains, { desc }) => [desc(domains.isPrimary)],
  });

  return domain?.domain || null;
}

/**
 * Setup Nginx and domain for a deployed project
 */
async function setupNginxAndDomain(
  ssh: SSHClient,
  server: typeof servers.$inferSelect,
  projectId: string,
  projectSlug: string,
  hostPort: number,
  onProgress: (msg: string) => void,
): Promise<string> {
  let primaryDomain = await getPrimaryDomain(projectId);

  const { env: envConfig } = await import('../config/env');
  const previewBaseUrl = envConfig.PREVIEW_BASE_URL;

  // Does THIS target server carry the *.<previewBaseUrl> wildcard cert? Only Pushify's
  // own shared host does — a user's own server never will. Auto-subdomains (*.pushify.dev)
  // only work where that wildcard cert lives AND where the *.pushify.dev DNS points.
  let hasWildcardSSL = false;
  if (previewBaseUrl) {
    const sslPath = envConfig.WILDCARD_SSL_PATH || `/etc/letsencrypt/live/${previewBaseUrl}`;
    const sslCheck = await ssh.exec(`test -f ${sslPath}/fullchain.pem && echo "exists" || echo "missing"`);
    hasWildcardSSL = sslCheck.stdout?.trim() === 'exists';
  }

  const isPushifyAutoSubdomain = (d: string | null): boolean =>
    !!d && !!previewBaseUrl && d.endsWith(`.${previewBaseUrl}`);

  // If the project carries a *.pushify.dev auto-subdomain but THIS server isn't the shared
  // host (no wildcard cert) — e.g. the project was created on the shared host then moved to
  // the user's own server — the subdomain is unusable here: its DNS points at Pushify's
  // host, not this server, and the wildcard cert isn't present. Drop the auto-generated
  // record and serve over the server's IP instead.
  if (isPushifyAutoSubdomain(primaryDomain) && !hasWildcardSSL) {
    onProgress(`🌐 Auto subdomain ${primaryDomain} only works on Pushify's shared host — this is your own server. Serving via http://${server.ipv4}:${hostPort}`);
    try {
      await db.delete(domains).where(and(eq(domains.projectId, projectId), eq(domains.isAutoGenerated, true)));
    } catch (err) {
      onProgress(`⚠️ Could not remove stale auto subdomain record: ${err instanceof Error ? err.message : 'unknown'}`);
    }
    primaryDomain = null;
  }

  if (!primaryDomain) {
    if (previewBaseUrl && hasWildcardSSL) {
      // Pushify's shared host — give the project a free *.pushify.dev subdomain.
      onProgress('🌐 No domain configured, creating auto subdomain...');
      try {
        const autoDomain = await domainService.createAutoSubdomain(projectId, projectSlug, server.id);
        if (autoDomain) {
          primaryDomain = autoDomain.domain;
          onProgress(`✅ Auto subdomain created: ${primaryDomain}`);
        }
      } catch (autoSubError) {
        onProgress(`⚠️ Auto subdomain creation warning: ${autoSubError instanceof Error ? autoSubError.message : 'Unknown error'}`);
      }
    } else {
      // User's own server (or no preview base): no auto subdomain — access via the server IP.
      onProgress(`🌐 No domain configured. Access via: http://${server.ipv4}:${hostPort}`);
    }
  }

  if (primaryDomain) {
    const isAutoSubdomain = isPushifyAutoSubdomain(primaryDomain);

    if (isAutoSubdomain) {
      onProgress(`🌐 Configuring Nginx for auto subdomain: ${primaryDomain}`);
      const addResult = await addAutoSubdomainSite(ssh, { domain: primaryDomain, containerPort: hostPort, projectSlug });
      if (!addResult.success) {
        onProgress(`⚠️ Nginx config warning: ${addResult.message}`);
      } else {
        onProgress('✅ Nginx site configured with wildcard SSL');
        const reloadResult = await reloadNginx(ssh);
        if (!reloadResult.success) onProgress(`⚠️ Nginx reload warning: ${reloadResult.message}`);
        else onProgress('✅ Nginx reloaded');
      }
    } else {
      onProgress(`🌐 Configuring Nginx for domain: ${primaryDomain}`);
      const addResult = await addSite(ssh, { domain: primaryDomain, containerPort: hostPort, projectSlug, ssl: false });
      if (!addResult.success) {
        onProgress(`⚠️ Nginx config warning: ${addResult.message}`);
      } else {
        onProgress('✅ Nginx site configured');
        const reloadResult = await reloadNginx(ssh);
        if (!reloadResult.success) onProgress(`⚠️ Nginx reload warning: ${reloadResult.message}`);
        else onProgress('✅ Nginx reloaded');

        onProgress('🔐 Requesting SSL certificate...');
        try {
          const sslResult = await requestSSLCertificate(ssh, primaryDomain, 'ssl@pushify.app');
          if (sslResult.success) {
            onProgress('✅ SSL certificate obtained');
            await addSite(ssh, { domain: primaryDomain, containerPort: hostPort, projectSlug, ssl: true });
            await reloadNginx(ssh);
          } else {
            onProgress(`⚠️ SSL certificate failed: ${sslResult.message}`);
          }
        } catch (sslError) {
          onProgress(`⚠️ SSL certificate error: ${sslError instanceof Error ? sslError.message : 'Unknown error'}`);
        }
      }
    }
  }

  if (primaryDomain) {
    return `https://${primaryDomain}`;
  }
  return `http://${server.ipv4}:${hostPort}`;
}

/**
 * Deploy a project to a remote server
 */
export async function deployToRemoteServer(
  config: RemoteDeploymentConfig
): Promise<RemoteDeploymentResult> {
  const {
    serverId,
    projectId,
    projectSlug,
    deploymentId,
    repoUrl,
    branch,
    commitHash,
    port: configPort,
    envVars,
    buildCommand,
    startCommand,
    installCommand = 'npm install --legacy-peer-deps',
    rootDirectory: rootDirectoryInput = '.',
    dockerfilePath,
    outputDirectory,
    framework: frameworkHint,
    buildpackId: configBuildpackId,
    accessToken,
    onProgress,
    deploySuffix = '',
  } = config;

  const rootDirectory = normalizeRootDirectory(rootDirectoryInput);
  const deploySlug = `${projectSlug}${deploySuffix}`;

  // Determine container port: prefer PORT from env vars, then config port, then default 3000
  const envPort = envVars?.PORT ? parseInt(envVars.PORT, 10) : null;
  const containerPort = envPort || configPort || 3000;
  onProgress(`📌 Container port: ${containerPort}${envPort ? ' (from env PORT)' : configPort ? ' (from project config)' : ' (default)'}`);

  // Add PORT to envVars if not set, so the app knows which port to listen on
  if (!envVars?.PORT) {
    envVars.PORT = String(containerPort);
  }

  let ssh: SSHClient | null = null;

  try {
    // Connect to server
    onProgress('🔌 Connecting to deployment server...');
    const { server, ssh: sshClient } = await getServerAndConnect(serverId);
    ssh = sshClient;

    // Verify Docker is available
    onProgress('🐳 Checking Docker availability...');
    const dockerStatus = await checkDocker(ssh);
    if (!dockerStatus.available) {
      throw new Error(`Docker is not available on server: ${dockerStatus.error}`);
    }
    onProgress(`✅ Docker ${dockerStatus.version} is available`);

    // Create project directory
    const projectDir = `/opt/pushify/apps/${projectSlug}`;
    const repoDir = `${projectDir}/repo`;

    onProgress(`📁 Creating project directory: ${projectDir}`);
    await ssh.exec(`mkdir -p ${projectDir}`);

    // ── Marketplace COMPOSE deploy: deploy multi-container stack ──
    if (config.marketplace?.deploymentType === 'docker-compose' && config.marketplace.composeFile) {
      const stackName = `pushify-${deploySlug}`;
      onProgress(`📦 Deploying Docker Compose stack: ${stackName}`);

      // Check docker compose plugin
      const composeCheck = await ssh.exec('docker compose version 2>&1');
      if (!composeCheck.stdout.includes('Docker Compose')) {
        throw new Error('Docker Compose plugin not installed on server');
      }
      onProgress(`✅ ${composeCheck.stdout.trim()}`);

      // Find a free public port (5000-5999 range)
      onProgress(`🔍 Finding available host port...`);
      const findPortCmd = `for p in $(seq 5000 5999); do ss -tln 2>/dev/null | grep -q ":$p " || { echo $p; break; }; done`;
      const portFindResult = await ssh.exec(findPortCmd);
      const publicHostPort = parseInt(portFindResult.stdout.trim()) || 5000;
      const internalPort = config.marketplace.composePublicPort || 80;
      onProgress(`📌 Assigned host port: ${publicHostPort} → container ${internalPort}`);

      const publicUrl = `http://${server.ipv4}:${publicHostPort}`;
      const composePath = `${projectDir}/docker-compose.yml`;
      const composeCmd = (args: string) =>
        `cd ${projectDir} && docker compose --env-file .env -p ${stackName} ${args}`;

      // Write any extra files (e.g. kong.yml). Substitute ${VAR} with env values.
      const allEnvs: Record<string, string> = {
        ...envVars,
        PUSHIFY_PUBLIC_PORT: String(publicHostPort),
        // Common port env names that compose files use
        KONG_HTTP_PORT: String(publicHostPort),
        APP_PORT: String(publicHostPort),
        APPWRITE_HTTP_PORT: String(publicHostPort),
        HTTP_PORT: String(publicHostPort),
        WEB_PORT: String(publicHostPort),
        PORT: String(publicHostPort),
        // Common public URL env names (auto-injected so users don't need to set them)
        SITE_URL: envVars.SITE_URL || publicUrl,
        API_EXTERNAL_URL: envVars.API_EXTERNAL_URL || publicUrl,
        SUPABASE_PUBLIC_URL: envVars.SUPABASE_PUBLIC_URL || publicUrl,
        PUBLIC_URL: envVars.PUBLIC_URL || publicUrl,
        APP_URL: envVars.APP_URL || publicUrl,
        // Cal.com / Next.js apps
        NEXT_PUBLIC_WEBAPP_URL: envVars.NEXT_PUBLIC_WEBAPP_URL || publicUrl,
        NEXTAUTH_URL: envVars.NEXTAUTH_URL || envVars.NEXT_PUBLIC_WEBAPP_URL || publicUrl,
      };

      // Cal.com: host allowlist, Stripe placeholders, Redis, extra_hosts (IP:port OK without domain)
      if (
        config.marketplace.id === 'calcom' ||
        config.marketplace.composePublicService === 'calcom'
      ) {
        Object.assign(allEnvs, applyCalcomEnvDefaults(allEnvs, { publicUrl }));
        onProgress(
          `🔧 Cal.com env: URL=${allEnvs.NEXT_PUBLIC_WEBAPP_URL}, DATABASE_HOST=${allEnvs.DATABASE_HOST}`
        );
      }
      const envFileContent = Object.entries(allEnvs)
        .map(([k, v]) => `${k}=${v.replace(/\n/g, '\\n')}`)
        .join('\n');
      await ssh.uploadFile(envFileContent, `${projectDir}/.env`);
      onProgress(`📝 Wrote ${Object.keys(allEnvs).length} env vars to .env`);

      // Write compose after .env values are known (bake Cal.com extra_hosts — empty var breaks compose)
      let composeContent = config.marketplace.composeFile;
      const isCalcom =
        config.marketplace.id === 'calcom' ||
        config.marketplace.composePublicService === 'calcom';
      if (isCalcom) {
        const extraHost = getCalcomExtraHost(publicUrl);
        const allowedHost = getCalcomAllowedHostPlaceholder(publicUrl);
        composeContent = composeContent
          .replace('PUSHIFY_CALCOM_EXTRA_HOST_PLACEHOLDER', extraHost)
          .replace('PUSHIFY_CALCOM_ALLOWED_HOST_PLACEHOLDER', allowedHost);
        onProgress(
          `📝 Cal.com hosts: ALLOWED_HOSTNAMES="${allowedHost}", extra_hosts=${extraHost}:host-gateway`
        );

        const imageTag = calcomImageTag(publicUrl);
        const buildScriptPath = `${projectDir}/pushify-build-calcom.sh`;
        const buildScript = buildCalcomImageScript({
          projectDir,
          publicUrl,
          imageTag,
          nextAuthSecret: allEnvs.NEXTAUTH_SECRET || '',
          encryptionKey: allEnvs.CALENDSO_ENCRYPTION_KEY || '',
        });
        await ssh.uploadFile(buildScript, buildScriptPath);
        await ssh.exec(`chmod +x ${buildScriptPath}`);
        onProgress(
          `🔨 Building Cal.com image for ${publicUrl} (cached as ${imageTag}; first run ~15–30 min)…`
        );
        const buildResult = await ssh.exec(`bash ${buildScriptPath} 2>&1`);
        const buildTail = `${buildResult.stdout}\n${buildResult.stderr}`.trim().split('\n').slice(-15).join('\n');
        if (buildResult.code !== 0) {
          onProgress(
            `⚠️ Cal.com custom build failed — using Hub image + runtime URL replace. Tail:\n${buildTail}`
          );
        } else {
          onProgress(`✅ Cal.com image ready: ${imageTag}`);
          if (buildTail) onProgress(buildTail);
          composeContent = composeContent.replace(
            'image: calcom/cal.com:latest',
            `image: ${imageTag}`
          );
        }
      }
      onProgress(`📝 Writing docker-compose.yml...`);
      await ssh.uploadFile(composeContent, composePath);

      const extraFiles = config.marketplace.extraFiles;
      if (extraFiles && Object.keys(extraFiles).length > 0) {
        for (const [filename, contents] of Object.entries(extraFiles)) {
          const expanded = contents.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, key) => allEnvs[key] ?? '');
          const filePath = `${projectDir}/${filename}`;
          await ssh.uploadFile(expanded, filePath);
          onProgress(`📝 Wrote ${filename}`);
        }
      }

      // Stop existing stack if any
      onProgress(`🛑 Stopping existing stack (if any)...`);
      await ssh.exec(`${composeCmd('down')} 2>&1 || true`);

      // Pull all images
      onProgress(`⬇️ Pulling images (this may take a while)...`);
      const pullResult = await ssh.exec(`${composeCmd('pull')} 2>&1`);
      if (pullResult.code !== 0) {
        onProgress(`⚠️ Some images failed to pull, continuing...`);
      }

      // Open firewall port (best-effort; ufw / firewalld / iptables, root-first for BYOS)
      await openFirewallPort(ssh, publicHostPort, onProgress);

      // Start the stack (--env-file required for ${VAR} substitution in compose YAML)
      onProgress(`🚀 Starting stack...`);
      const upResult = await ssh.exec(`${composeCmd('up -d')} 2>&1`);
      const upOutput = `${upResult.stdout}\n${upResult.stderr}`;
      if (
        upResult.code !== 0 ||
        upOutput.includes('decoding failed') ||
        upOutput.includes('bad host name')
      ) {
        throw new Error(
          `Docker Compose failed to start stack. Run on server: cd ${projectDir} && docker compose --env-file .env -p ${stackName} up -d\n${upOutput.slice(-800)}`
        );
      }

      const runningCheck = await ssh.exec(`${composeCmd('ps -q')} 2>&1`);
      if (!runningCheck.stdout.trim()) {
        throw new Error(
          `No containers running after compose up. Check: ${composeCmd('logs')} 2>&1 | tail -50`
        );
      }
      onProgress(`✅ ${runningCheck.stdout.trim().split('\n').length} container(s) running`);

      // ── Post-deploy: run any post-deploy SQL/scripts to fix common issues ──
      const postDeploySql = (config.marketplace as any).postDeploySql as string | undefined;
      if (postDeploySql) {
        onProgress(`🩹 Running post-deploy fixup (waiting for db to be ready)...`);
        // Wait for db container to be healthy (max 90s)
        for (let i = 0; i < 30; i++) {
          const check = await ssh.exec(
            `docker exec ${stackName}-db-1 pg_isready -U postgres 2>&1 | grep -c "accepting" || true`
          );
          if (check.stdout.trim() === '1') break;
          await new Promise((r) => setTimeout(r, 3000));
        }

        // Substitute env vars into the SQL
        const expandedSql = postDeploySql.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, key) => envVars[key] ?? '');
        // Upload SQL to a temp file on remote
        const tmpSqlPath = `${projectDir}/.post-deploy.sql`;
        await ssh.uploadFile(expandedSql, tmpSqlPath);
        // Run inside db container as postgres (which Postgres image creates as superuser)
        const sqlResult = await ssh.exec(
          `docker exec -i ${stackName}-db-1 psql -U postgres -d postgres -f - < ${tmpSqlPath} 2>&1 || true`
        );
        await ssh.exec(`rm -f ${tmpSqlPath}`);
        onProgress(`✅ Post-deploy SQL applied`);

        // Restart services that depend on the fixed credentials
        onProgress(`🔄 Restarting dependent services...`);
        await ssh.exec(`${composeCmd('restart')} 2>&1 || true`);
      }

      // Cal.com needs migrations + Next.js boot — wait for health (up to ~5 min)
      if (config.marketplace.composePublicService === 'calcom') {
        onProgress(`⏳ Waiting for Cal.com to become ready (migrations may take 3–5 min)...`);
        const healthUrl = `http://127.0.0.1:${publicHostPort}/api/health`;
        let ready = false;
        for (let i = 0; i < 60; i++) {
          const probe = await ssh.exec(
            `curl -sf -o /dev/null -w "%{http_code}" ${healthUrl} 2>/dev/null || echo "000"`
          );
          const code = probe.stdout.trim();
          if (code === '200') {
            ready = true;
            break;
          }
          if (i > 0 && i % 6 === 0) {
            const logs = await ssh.exec(
              `${composeCmd('logs calcom --tail 8')} 2>&1 || true`
            );
            const tail = logs.stdout.trim().split('\n').slice(-3).join(' | ');
            if (tail) onProgress(`   Cal.com: ${tail}`);
          }
          await new Promise((r) => setTimeout(r, 5000));
        }
        const homeProbe = await ssh.exec(
          `curl -sf -o /dev/null -w "%{http_code}" http://127.0.0.1:${publicHostPort}/ 2>/dev/null || echo "000"`
        );
        const homeCode = homeProbe.stdout.trim();
        if (ready) {
          onProgress(`✅ Cal.com is responding on port ${publicHostPort}`);
        } else {
          onProgress(
            `⚠️ Cal.com health check pending — check logs: cd ${projectDir} && docker compose --env-file .env -p ${stackName} logs calcom --tail 40`
          );
        }
        if (homeCode === '500' || homeCode === '000') {
          const errLogs = await ssh.exec(
            `${composeCmd('logs calcom --tail 25')} 2>&1 || true`
          );
          const tail = errLogs.stdout.trim().split('\n').slice(-8).join(' | ');
          if (tail) onProgress(`⚠️ Cal.com homepage returned ${homeCode}: ${tail}`);
        }
      }

      onProgress(`✅ Stack deployed: ${stackName} (port ${publicHostPort})`);
      const siteUrl = `http://${server.ipv4}:${publicHostPort}`;
      onProgress(`🌐 Your site: ${siteUrl}`);
      if (isCalcom) {
        onProgress(`📋 First-time setup (open after ~3 min): ${siteUrl}/auth/setup`);
        onProgress(`💡 No manual server steps needed — Pushify configured env, firewall port, and Docker for you.`);
      } else {
        onProgress(
          `💡 If the URL does not load externally, open TCP port ${publicHostPort} in your cloud firewall (e.g. Hetzner).`
        );
      }

      return {
        success: true,
        deploymentUrl: siteUrl,
        containerPort: publicHostPort,
      };
    }

    // ── Marketplace deploy: pull image directly ──
    if (config.marketplace) {
      const { dockerImage, dockerCommand, volumes } = config.marketplace;
      if (!dockerImage) throw new Error('Marketplace deploy requires dockerImage');
      const imageName = `pushify-${deploySlug}`;
      const containerName = `pushify-${deploySlug}`;
      const dbContainerName = `pushify-${deploySlug}-db`;

      // Check if app requires a database and start one
      const requiresDb = config.marketplace.requiresDatabase;
      if (requiresDb) {
        onProgress(`🗄️ Setting up ${requiresDb.type} database...`);

        const dbImage = requiresDb.type === 'mysql' ? `mysql:${requiresDb.version || '8.0'}` : `postgres:${requiresDb.version || '16'}-alpine`;
        const dbPassword = envVars.WORDPRESS_DB_PASSWORD || envVars.DB_PASSWORD || envVars.POSTGRES_PASSWORD || 'pushify_auto_' + Math.random().toString(36).substring(2, 10);
        const dbName = envVars.WORDPRESS_DB_NAME || envVars.DB_NAME || envVars.POSTGRES_DB || projectSlug.replace(/-/g, '_');
        const dbUser = envVars.WORDPRESS_DB_USER || envVars.DB_USER || envVars.POSTGRES_USER || 'pushify';

        // Pull DB image
        onProgress(`📦 Pulling ${dbImage}...`);
        await ssh.exec(`docker pull ${dbImage}`);

        // Stop existing DB container
        await ssh.exec(`docker stop ${dbContainerName} 2>/dev/null; docker rm ${dbContainerName} 2>/dev/null`);

        // Create data directory for DB
        await ssh.exec(`mkdir -p ${projectDir}/data/db`);

        // Start DB container
        let dbEnvFlags: string;
        let dbVolPath: string;
        if (requiresDb.type === 'mysql') {
          dbEnvFlags = `-e MYSQL_ROOT_PASSWORD='${dbPassword.replace(/'/g, "'\\''")}' -e MYSQL_DATABASE='${dbName}' -e MYSQL_USER='${dbUser}' -e MYSQL_PASSWORD='${dbPassword.replace(/'/g, "'\\''")}'`;
          dbVolPath = `/var/lib/mysql`;
        } else {
          dbEnvFlags = `-e POSTGRES_PASSWORD='${dbPassword.replace(/'/g, "'\\''")}' -e POSTGRES_DB='${dbName}' -e POSTGRES_USER='${dbUser}'`;
          dbVolPath = `/var/lib/postgresql/data`;
        }

        const dbRunCmd = `docker run -d --name ${dbContainerName} --restart unless-stopped -v ${projectDir}/data/db:${dbVolPath} ${dbEnvFlags} ${dbImage}`;
        const dbRunResult = await ssh.exec(dbRunCmd);
        if (dbRunResult.code !== 0) {
          throw new Error(`Failed to start database: ${dbRunResult.stderr}`);
        }
        onProgress(`✅ ${requiresDb.type} database started`);

        // Wait for DB to be ready
        onProgress('⏳ Waiting for database to be ready...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Force DB host to container name (Docker networking requires this)
        const dbScheme = requiresDb.type === 'mysql' ? 'mysql' : 'postgres';
        const dbPort = requiresDb.type === 'mysql' ? 3306 : 5432;

        // Auto-inject all common DB env var aliases used by various apps:
        // WordPress, Directus, Strapi, Rails, Django, Hasura, Ghost, etc.
        envVars.WORDPRESS_DB_HOST = dbContainerName;
        envVars.WORDPRESS_DB_NAME = dbName;
        envVars.WORDPRESS_DB_USER = dbUser;
        envVars.WORDPRESS_DB_PASSWORD = dbPassword;

        envVars.DB_HOST = dbContainerName;
        envVars.DB_PORT = String(dbPort);
        envVars.DB_DATABASE = dbName;
        envVars.DB_NAME = envVars.DB_NAME || dbName;
        envVars.DB_USER = envVars.DB_USER || dbUser;
        envVars.DB_USERNAME = dbUser;
        envVars.DB_PASSWORD = envVars.DB_PASSWORD || dbPassword;
        envVars.DB_CLIENT = requiresDb.type === 'mysql' ? 'mysql' : 'pg';

        envVars.DATABASE_HOST = dbContainerName;
        envVars.DATABASE_PORT = String(dbPort);
        envVars.DATABASE_NAME = dbName;
        envVars.DATABASE_USER = dbUser;
        envVars.DATABASE_USERNAME = dbUser; // Strapi / Medusa expect DATABASE_USERNAME
        envVars.DATABASE_PASSWORD = dbPassword;
        // Let the template choose the client (e.g. Strapi DATABASE_CLIENT=postgres); only
        // fill it in when it wasn't provided so SQLite can't sneak back as the default.
        envVars.DATABASE_CLIENT = envVars.DATABASE_CLIENT || (requiresDb.type === 'mysql' ? 'mysql' : 'postgres');
        envVars.DATABASE_SSL = envVars.DATABASE_SSL || 'false';

        envVars.POSTGRES_HOST = dbContainerName;
        envVars.POSTGRES_DB = envVars.POSTGRES_DB || dbName;
        envVars.POSTGRES_USER = envVars.POSTGRES_USER || dbUser;
        envVars.POSTGRES_PASSWORD = envVars.POSTGRES_PASSWORD || dbPassword;

        // Full connection URL for apps that expect a single DSN
        // (Hasura, Strapi, Rails, Django, Prisma, etc.)
        const fullUrl = `${dbScheme}://${dbUser}:${dbPassword}@${dbContainerName}:${dbPort}/${dbName}`;
        envVars.DATABASE_URL = envVars.DATABASE_URL || fullUrl;
        envVars.HASURA_GRAPHQL_DATABASE_URL = envVars.HASURA_GRAPHQL_DATABASE_URL || fullUrl;
        envVars.PG_DATABASE_URL = envVars.PG_DATABASE_URL || fullUrl;

        onProgress(`🔗 Database host set to: ${dbContainerName}`);
      }

      onProgress(`📦 Pulling Docker image: ${dockerImage}`);
      const pullResult = await ssh.exec(`docker pull ${dockerImage}`);
      if (pullResult.code !== 0) {
        throw new Error(`Failed to pull image: ${pullResult.stderr}`);
      }
      onProgress('✅ Image pulled successfully');

      // Tag it locally
      await ssh.exec(`docker tag ${dockerImage} ${imageName}:latest`);

      // Assign port
      const { port: hostPort } = await getOrAssignPort(ssh, projectSlug);
      onProgress(`🔌 Assigned port: ${hostPort} -> ${containerPort}`);

      // Build env var flags
      const envFlags = Object.entries(envVars)
        .map(([k, v]) => `-e ${k}='${v.replace(/'/g, "'\\''")}'`)
        .join(' ');

      // Build volume flags. Templates can specify volumes in two formats:
      //   '/path/in/container'        → host path auto-derived from project dir
      //   'host/path:/container/path' → explicit host:container mapping
      const volFlags = (volumes || [])
        .map((v) => {
          if (v.includes(':')) {
            // Explicit host:container mapping
            const [hostPath, containerPath] = v.split(':');
            const fullHostPath = hostPath.startsWith('/') ? hostPath : `${projectDir}/data/${hostPath}`;
            return `-v ${fullHostPath}:${containerPath}`;
          }
          // Single path = container path; auto-derive host path
          const containerPath = v;
          const hostPath = `${projectDir}/data${containerPath}`;
          return `-v ${hostPath}:${containerPath}`;
        })
        .join(' ');

      // Create data directories for volumes
      if (volumes && volumes.length > 0) {
        for (const v of volumes) {
          let dir: string;
          if (v.includes(':')) {
            const [hostPath] = v.split(':');
            dir = hostPath.startsWith('/') ? hostPath : `${projectDir}/data/${hostPath}`;
          } else {
            dir = `${projectDir}/data${v}`;
          }
          await ssh.exec(`mkdir -p ${dir}`);
        }
      }

      // Stop existing container
      await ssh.exec(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null`);

      // Create Docker network for app <-> db communication
      const networkName = `pushify-${deploySlug}-net`;
      await ssh.exec(`docker network create ${networkName} 2>/dev/null || true`);
      if (requiresDb) {
        await ssh.exec(`docker network connect ${networkName} ${dbContainerName} 2>/dev/null || true`);
      }

      // Run container
      const cmdOverride = dockerCommand ? ` ${dockerCommand}` : '';
      const networkFlag = requiresDb ? `--network ${networkName}` : '';
      const runCmd = `docker run -d --name ${containerName} --restart unless-stopped ${networkFlag} -p ${hostPort}:${containerPort} ${envFlags} ${volFlags} ${imageName}:latest${cmdOverride}`;

      onProgress(`🚀 Starting container: ${containerName}`);
      const runResult = await ssh.exec(runCmd);
      if (runResult.code !== 0) {
        throw new Error(`Failed to start container: ${runResult.stderr}`);
      }
      onProgress('✅ Container started');

      // ── Post-deploy shell command (e.g. create initial admin user) ──
      const postDeployShell = (config.marketplace as any).postDeployShell as string | undefined;
      if (postDeployShell) {
        onProgress(`🩹 Running post-deploy setup...`);
        // Wait a few seconds for the container to actually be ready
        await new Promise((r) => setTimeout(r, 5000));
        // Substitute env vars into command
        const expandedCmd = postDeployShell.replace(/\$\{([A-Z0-9_]+)\}/g, (_m, key) => envVars[key] ?? '');
        const shellResult = await ssh.exec(`docker exec ${containerName} sh -c "${expandedCmd.replace(/"/g, '\\"')}" 2>&1 || true`);
        if (shellResult.stdout) onProgress(`   ${shellResult.stdout.trim().split('\n').slice(0, 5).join('\n   ')}`);
        onProgress(`✅ Post-deploy setup complete`);
      }

      // Setup nginx + subdomain
      const deploymentUrl = await setupNginxAndDomain(ssh, server, projectId, projectSlug, hostPort, onProgress);

      return {
        success: true,
        deploymentUrl,
        containerPort: hostPort,
        dockerImageId: dockerImage,
      };
    }

    // ── Standard git deploy flow ──
    await ssh.exec(`rm -rf ${repoDir}`);

    // Clone repository
    onProgress(`📥 Cloning repository: ${repoUrl}`);

    // Build clone URL with token if available
    let cloneUrl = repoUrl;
    if (accessToken && repoUrl.includes('github.com')) {
      cloneUrl = repoUrl.replace('https://', `https://${accessToken}@`);
    } else if (accessToken && repoUrl.includes('gitlab')) {
      try {
        const parsed = new URL(repoUrl);
        cloneUrl = `${parsed.protocol}//oauth2:${accessToken}@${parsed.host}${parsed.pathname}`;
      } catch {
        cloneUrl = repoUrl.replace('https://', `https://oauth2:${accessToken}@`);
      }
    }

    const cloneCmd = branch
      ? `git clone --depth 1 --branch ${branch} "${cloneUrl}" "${repoDir}"`
      : `git clone --depth 1 "${cloneUrl}" "${repoDir}"`;

    const cloneResult = await ssh.exec(cloneCmd);
    if (cloneResult.code !== 0) {
      throw new Error(`Failed to clone repository: ${cloneResult.stderr}`);
    }
    onProgress('✅ Repository cloned');

    const disk = await checkServerDiskSpace(ssh);
    onProgress(disk.message);
    if (!disk.ok) {
      throw new Error(
        `Server disk is critically full (${disk.usedPercent}% used, ${disk.availGb} GB free). Free space on the server before deploying.`
      );
    }

    // Check if Dockerfile exists
    const workDir = rootDirectory === '.' ? repoDir : path.posix.join(repoDir, rootDirectory);
    const dockerfileCheckPath = dockerfilePath
      ? path.posix.join(repoDir, dockerfilePath)
      : path.posix.join(workDir, 'Dockerfile');

    const hasDockerfile = await ssh.fileExists(dockerfileCheckPath);

    let resolvedBuildpackId = configBuildpackId || 'nodejs';
    let resolvedFramework = frameworkHint || 'nodejs';

    if (!hasDockerfile) {
      // Use buildpack system for detection and Dockerfile generation
      const { detectBuildpackRemote, detectNextStandaloneRemote, getBuildpack } =
        await import('../buildpacks');

      onProgress('🔍 Auto-detecting language and framework...');
      let detection = await detectBuildpackRemote(ssh, repoDir, rootDirectory);
      if (!detection && frameworkHint) {
        detection = {
          buildpackId: configBuildpackId || 'nodejs',
          framework: frameworkHint,
          confidence: 80,
        };
      }

      let dockerfileContent: string;
      resolvedFramework = detection?.framework || frameworkHint || 'nodejs';
      resolvedBuildpackId = detection?.buildpackId || configBuildpackId || 'nodejs';

      let nextStandalone = false;
      if (resolvedFramework === 'nextjs') {
        nextStandalone = await detectNextStandaloneRemote(ssh, repoDir, rootDirectory);
        if (nextStandalone) {
          onProgress('📦 Next.js standalone detected — smaller production image');
        }
      }

      const dockerGenOpts = {
        framework: resolvedFramework,
        buildCommand,
        installCommand,
        startCommand,
        outputDirectory,
        port: containerPort,
        rootDirectory: '.',
        envVars,
        nextStandalone,
      };

      if (detection && detection.buildpackId !== 'custom') {
        const buildpack = getBuildpack(detection.buildpackId);
        if (buildpack) {
          onProgress(`✅ Detected: ${buildpack.name} (${detection.framework})`);
          dockerfileContent = buildpack.generateDockerfile({
            ...dockerGenOpts,
            framework: detection.framework,
          } as any);
        } else {
          dockerfileContent = generateDockerfile(dockerGenOpts);
        }
      } else {
        dockerfileContent = generateDockerfile(dockerGenOpts);
      }

      onProgress('📄 Uploading Dockerfile...');
      await ssh.uploadFile(dockerfileContent, path.posix.join(workDir, 'Dockerfile'));
      onProgress('✅ Dockerfile generated');
    } else {
      onProgress('✅ Using existing Dockerfile');
    }

    // Build Docker image
    const imageName = `pushify-${deploySlug}`;
    const imageTag = commitHash.substring(0, 7);

    onProgress(`🔨 Building Docker image: ${imageName}:${imageTag}`);

    // Pass all env vars as build args
    const buildArgs: Record<string, string> = envVars ? { ...envVars } : {};

    onProgress(
      `📋 Build target: ${resolvedBuildpackId} (${resolvedFramework}) — glibc Linux images, tuned memory`
    );

    const buildResult = await buildImage(ssh, {
      workDir,
      imageName,
      tag: imageTag,
      dockerfilePath: dockerfilePath ? path.posix.join(repoDir, dockerfilePath) : undefined,
      buildArgs: Object.keys(buildArgs).length > 0 ? buildArgs : undefined,
      framework: resolvedFramework,
      buildpackId: resolvedBuildpackId,
      onProgress,
    });

    if (!buildResult.success) {
      throw new Error(`Docker build failed:\n${buildResult.logs}`);
    }
    onProgress('✅ Docker image built successfully');

    // Get the Docker image ID for rollback support
    let dockerImageId: string | null = null;
    try {
      dockerImageId = await getImageId(ssh, imageName, imageTag);
      if (dockerImageId) {
        onProgress(`📋 Image ID: ${dockerImageId.substring(0, 12)}`);

        // Tag with deployment ID for preservation (allows quick rollback)
        const deploymentTag = `deploy-${deploymentId.substring(0, 8)}`;
        await tagImage(ssh, `${imageName}:${imageTag}`, `${imageName}:${deploymentTag}`);
        onProgress(`🏷️ Tagged image: ${imageName}:${deploymentTag}`);

        // Also tag as latest
        await tagImage(ssh, `${imageName}:${imageTag}`, `${imageName}:latest`);
        onProgress(`🏷️ Tagged image: ${imageName}:latest`);

        // Cleanup old images (keep last 5)
        const cleanupResult = await cleanupOldImages(ssh, imageName, 5);
        if (cleanupResult.removedCount > 0) {
          onProgress(`🧹 Cleaned up ${cleanupResult.removedCount} old image(s)`);
        }
      }
    } catch (tagError) {
      // Non-fatal error - image is still built
      onProgress(`⚠️ Image tagging warning: ${tagError instanceof Error ? tagError.message : 'Unknown error'}`);
    }

    // Determine host port: if user specified PORT in env, use that; otherwise use port-manager
    let hostPort: number;
    let portSource: string;

    if (envPort) {
      // User specified PORT in env - use it for both host and container
      hostPort = envPort;
      portSource = 'from env PORT';
      onProgress(`🔍 Using user-specified port: ${hostPort} (from env PORT)`);
    } else {
      // No PORT specified - assign dynamically
      onProgress('🔍 Assigning port...');
      const { port: assignedPort, isNew } = await getOrAssignPort(ssh, deploySlug);
      hostPort = assignedPort;
      portSource = isNew ? 'newly assigned' : 'existing';
      onProgress(`✅ Port assigned: ${hostPort} (${portSource})`);
    }

    // Use blue-green deployment for zero-downtime updates
    onProgress('🔵🟢 Starting blue-green deployment...');

    const blueGreenResult = await blueGreenDeploy(ssh, {
      imageName: `${imageName}:${imageTag}`,
      containerName: `pushify-${deploySlug}`,
      hostPort,
      containerPort,
      envVars,
      restart: 'unless-stopped',
      healthCheckTimeout: 60, // 60 seconds to become healthy
      framework: resolvedFramework,
      buildpackId: resolvedBuildpackId,
      onProgress,
    });

    if (!blueGreenResult.success) {
      throw new Error(`Blue-green deployment failed:\n${blueGreenResult.logs}`);
    }

    // Complete the blue-green switch (update ports and stop old container)
    onProgress('🔄 Switching traffic to new container...');
    const switchResult = await completeBlueGreenSwitch(ssh, {
      newContainerName: blueGreenResult.newContainerName!,
      oldContainerName: blueGreenResult.oldContainerName,
      targetPort: hostPort,
      containerPort,
      onProgress,
    });

    if (!switchResult.success) {
      throw new Error(`Blue-green switch failed: ${switchResult.message}`);
    }
    onProgress('✅ Zero-downtime deployment successful');

    // Open firewall port for external access (root-first; works on BYOS without sudo/ufw)
    await openFirewallPort(ssh, hostPort, onProgress);

    // Check if project has any domains; if not, create auto subdomain (only on managed servers)
    let primaryDomain = await getPrimaryDomain(projectId);

    const { env: envConfig } = await import('../config/env');
    const previewBaseUrl = envConfig.PREVIEW_BASE_URL;

    // Only Pushify's shared host carries the *.<previewBaseUrl> wildcard cert; a user's own
    // server never will. Auto-subdomains (*.pushify.dev) only work where that cert lives AND
    // where the *.pushify.dev DNS points.
    let hasWildcardSSL = false;
    if (previewBaseUrl) {
      const sslPath = envConfig.WILDCARD_SSL_PATH || `/etc/letsencrypt/live/${previewBaseUrl}`;
      const sslCheck = await ssh.exec(`test -f ${sslPath}/fullchain.pem && echo "exists" || echo "missing"`);
      hasWildcardSSL = sslCheck.stdout?.trim() === 'exists';
    }

    const isPushifyAutoSubdomain = (d: string | null): boolean =>
      !!d && !!previewBaseUrl && d.endsWith(`.${previewBaseUrl}`);

    // Project carries a *.pushify.dev auto-subdomain but this isn't the shared host (no
    // wildcard cert) — e.g. it was moved to the user's own server. The subdomain's DNS
    // points at Pushify's host, not here. Drop the auto-generated record; serve via IP.
    if (isPushifyAutoSubdomain(primaryDomain) && !hasWildcardSSL) {
      onProgress(`🌐 Auto subdomain ${primaryDomain} only works on Pushify's shared host — this is your own server. Serving via http://${server.ipv4}:${hostPort}`);
      try {
        await db.delete(domains).where(and(eq(domains.projectId, projectId), eq(domains.isAutoGenerated, true)));
      } catch (err) {
        onProgress(`⚠️ Could not remove stale auto subdomain record: ${err instanceof Error ? err.message : 'unknown'}`);
      }
      primaryDomain = null;
    }

    if (!primaryDomain) {
      if (previewBaseUrl && hasWildcardSSL) {
        onProgress('🌐 No domain configured, creating auto subdomain...');
        try {
          const autoDomain = await domainService.createAutoSubdomain(projectId, projectSlug, serverId);
          if (autoDomain) {
            primaryDomain = autoDomain.domain;
            onProgress(`✅ Auto subdomain created: ${primaryDomain}`);
          }
        } catch (autoSubError) {
          onProgress(`⚠️ Auto subdomain creation warning: ${autoSubError instanceof Error ? autoSubError.message : 'Unknown error'}`);
        }
      } else {
        onProgress(`🌐 No domain configured. Access via: http://${server.ipv4}:${hostPort}`);
      }
    }

    // Configure Nginx
    if (primaryDomain) {
      const isAutoSubdomain = isPushifyAutoSubdomain(primaryDomain);

      if (isAutoSubdomain) {
        // Use wildcard cert for auto subdomains
        onProgress(`🌐 Configuring Nginx for auto subdomain: ${primaryDomain}`);

        const addResult = await addAutoSubdomainSite(ssh, {
          domain: primaryDomain,
          containerPort: hostPort,
          projectSlug,
        });

        if (!addResult.success) {
          onProgress(`⚠️ Nginx config warning: ${addResult.message}`);
        } else {
          onProgress('✅ Nginx site configured with wildcard SSL');
          const reloadResult = await reloadNginx(ssh);
          if (!reloadResult.success) {
            onProgress(`⚠️ Nginx reload warning: ${reloadResult.message}`);
          } else {
            onProgress('✅ Nginx reloaded');
          }
        }
      } else {
        // Custom domain — use standard flow
        onProgress(`🌐 Configuring Nginx for domain: ${primaryDomain}`);

        const addResult = await addSite(ssh, {
          domain: primaryDomain,
          containerPort: hostPort,
          projectSlug,
          ssl: false, // Start without SSL, will be added after
        });

        if (!addResult.success) {
          onProgress(`⚠️ Nginx config warning: ${addResult.message}`);
        } else {
          onProgress('✅ Nginx site configured');

          // Reload Nginx
          const reloadResult = await reloadNginx(ssh);
          if (!reloadResult.success) {
            onProgress(`⚠️ Nginx reload warning: ${reloadResult.message}`);
          } else {
            onProgress('✅ Nginx reloaded');
          }

          // Try to get SSL certificate
          onProgress('🔐 Requesting SSL certificate...');
          try {
            const sslResult = await requestSSLCertificate(
              ssh,
              primaryDomain,
              'ssl@pushify.app'
            );

            if (sslResult.success) {
              onProgress('✅ SSL certificate obtained');

              // Update Nginx config with SSL
              await addSite(ssh, {
                domain: primaryDomain,
                containerPort: hostPort,
                projectSlug,
                ssl: true,
              });
              await reloadNginx(ssh);
            } else {
              onProgress(`⚠️ SSL certificate failed: ${sslResult.message}`);
            }
          } catch (sslError) {
            onProgress(`⚠️ SSL certificate error: ${sslError instanceof Error ? sslError.message : 'Unknown error'}`);
          }
        }
      }
    }

    // Determine deployment URL
    let deploymentUrl: string;
    if (primaryDomain) {
      deploymentUrl = `https://${primaryDomain}`;
    } else {
      deploymentUrl = `http://${server.ipv4}:${hostPort}`;
    }

    onProgress(`✅ Deployment successful! URL: ${deploymentUrl}`);

    return {
      success: true,
      deploymentUrl,
      containerPort: hostPort,
      dockerImageId: dockerImageId || undefined,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    // Disconnect SSH
    if (ssh) {
      ssh.disconnect();
    }
  }
}

/**
 * Check if a project can be deployed to a remote server
 */
export async function canDeployToServer(serverId: string): Promise<{
  canDeploy: boolean;
  reason?: string;
}> {
  try {
    const server = await db.query.servers.findFirst({
      where: eq(servers.id, serverId),
    });

    if (!server) {
      return { canDeploy: false, reason: 'Server not found' };
    }

    if (server.status !== 'running') {
      return { canDeploy: false, reason: `Server is not running (status: ${server.status})` };
    }

    if (server.setupStatus !== 'completed') {
      return { canDeploy: false, reason: `Server setup is not completed (status: ${server.setupStatus})` };
    }

    if (!server.ipv4) {
      return { canDeploy: false, reason: 'Server has no IP address' };
    }

    if (!server.sshPrivateKey) {
      return { canDeploy: false, reason: 'Server has no SSH key configured' };
    }

    return { canDeploy: true };
  } catch (error) {
    return {
      canDeploy: false,
      reason: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Quick rollback configuration - uses existing Docker image
 */
export interface QuickRollbackConfig {
  serverId: string;
  projectId: string;
  projectSlug: string;
  targetDeploymentId: string; // The deployment to rollback to
  port: number;
  envVars: Record<string, string>;
  onProgress: (message: string) => void;
}

/**
 * Perform a quick rollback using an existing Docker image
 * No build required - just swap containers
 */
export async function quickRollbackToDeployment(
  config: QuickRollbackConfig
): Promise<RemoteDeploymentResult> {
  const {
    serverId,
    projectId,
    projectSlug,
    targetDeploymentId,
    port: configPort,
    envVars,
    onProgress,
  } = config;

  let ssh: SSHClient | null = null;

  try {
    // Connect to server
    onProgress('🔌 Connecting to deployment server...');
    const { server, ssh: sshClient } = await getServerAndConnect(serverId);
    ssh = sshClient;

    // Verify Docker is available
    onProgress('🐳 Checking Docker availability...');
    const dockerStatus = await checkDocker(ssh);
    if (!dockerStatus.available) {
      throw new Error(`Docker is not available on server: ${dockerStatus.error}`);
    }

    const imageName = `pushify-${projectSlug}`;
    const deploymentTag = `deploy-${targetDeploymentId.substring(0, 8)}`;
    const fullImageName = `${imageName}:${deploymentTag}`;

    // Check if the target image exists
    onProgress(`🔍 Checking for rollback image: ${fullImageName}`);
    const imgExists = await imageExists(ssh, imageName, deploymentTag);
    if (!imgExists) {
      throw new Error(`Rollback image not found: ${fullImageName}. The image may have been cleaned up.`);
    }
    onProgress('✅ Rollback image found');

    // Determine container port
    const envPort = envVars?.PORT ? parseInt(envVars.PORT, 10) : null;
    const containerPort = envPort || configPort || 3000;
    if (!envVars?.PORT) {
      envVars.PORT = String(containerPort);
    }

    // Get or assign host port
    let hostPort: number;
    if (envPort) {
      hostPort = envPort;
      onProgress(`🔍 Using user-specified port: ${hostPort}`);
    } else {
      const { port: assignedPort } = await getOrAssignPort(ssh, projectSlug);
      hostPort = assignedPort;
      onProgress(`🔍 Using assigned port: ${hostPort}`);
    }

    // Run container from existing image (this handles stopping the old container)
    onProgress(`🐳 Starting container from image: ${fullImageName}`);
    const runResult = await runContainerFromImage(ssh, {
      imageName: fullImageName,
      containerName: `pushify-${projectSlug}`,
      hostPort,
      containerPort,
      envVars,
      restart: 'unless-stopped',
      onProgress,
    });

    if (!runResult.success) {
      throw new Error(`Failed to start container:\n${runResult.logs}`);
    }
    onProgress('✅ Container started successfully');

    // Update latest tag to point to rollback image
    await tagImage(ssh, fullImageName, `${imageName}:latest`);
    onProgress(`🏷️ Updated latest tag to ${deploymentTag}`);

    // Get primary domain for URL
    const primaryDomain = await getPrimaryDomain(projectId);

    // Determine deployment URL
    let deploymentUrl: string;
    if (primaryDomain) {
      deploymentUrl = `https://${primaryDomain}`;
    } else {
      deploymentUrl = `http://${server.ipv4}:${hostPort}`;
    }

    onProgress(`✅ Rollback successful! URL: ${deploymentUrl}`);

    return {
      success: true,
      deploymentUrl,
      containerPort: hostPort,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
    };
  } finally {
    if (ssh) {
      ssh.disconnect();
    }
  }
}
