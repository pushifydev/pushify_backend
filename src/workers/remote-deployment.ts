import { eq, and } from 'drizzle-orm';
import { redactUrlCredentials } from '../lib/utils';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { domains } from '../db/schema/projects';
import { SSHClient } from '../utils/ssh';
import { syncWorkerContainersOnDeploy } from './worker-process-sync';
import { decrypt } from '../lib/encryption';
import {
  buildImage,
  checkDocker,
  getImageId,
  tagImage,
  cleanupOldImages,
  imageExists,
  blueGreenDeploy,
  startExtraReplicas,
  APP_CONTAINER_HARDENING,
} from './remote-docker';
import { addAutoSubdomainSite, reloadNginx, CATCH_ALL_TLS_SCRIPT } from './nginx-manager';
import { shSingleQuote } from './shell';
import { syncProjectSites, describeSyncedDomains } from '../lib/project-sites';
import { isSharedRunnerServer } from '../lib/runner-routing';
import { DATABASE_NETWORK } from '../lib/managed-database';
import { applyRunnerIsolationCommand, RUNNER_APP_NETWORK } from '../lib/runner-isolation';
import {
  containerHoldingPort,
  canServePublicPort,
  publicPortAnswers,
  removePublicPortProxy,
  resolvePublicPort,
  writePublicPortProxy,
} from './public-port-proxy';
import { logger } from '../lib/logger';
import { cloudflareDnsConfigured, ensureAutoSubdomainRecord } from '../lib/cloudflare-dns';
import {
  applyCalcomEnvDefaults,
  buildComposeEnvOverride,
  getCalcomExtraHost,
  getCalcomAllowedHostPlaceholder,
} from '../marketplace/helpers';
import { buildCalcomImageScript, calcomImageTag } from '../marketplace/calcom-image';
import { getOrAssignPort, pickFreePorts, pickSwitchPort, recordPortAssignment } from './port-manager';
import { generateDockerfile } from './dockerfile';
import { normalizeRootDirectory } from '../lib/normalize-root-directory';
import { checkServerDiskSpace } from '../lib/server-disk-check';
import { domainService } from '../services/domain.service';
import path from 'path';

export interface RemoteDeploymentConfig {
  serverId: string;
  projectId: string;
  projectSlug: string;
  /** Persistent named-volume mounts (name:containerPath) applied to the app container */
  volumes?: string[];
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
  /** `framework` was pinned by pushify.yaml: use it as-is instead of auto-detecting */
  frameworkForced?: boolean;
  accessToken?: string;
  onProgress: (message: string) => void;
  /** e.g. `-pr-42` for preview deployments (separate container/image from production) */
  deploySuffix?: string;
  /** Which copy of the project this is: staging gets its own container, port and domains */
  environment?: 'production' | 'staging';
  /** How many containers to run behind nginx (1 = a single container, as before) */
  replicas?: number;
  /** Preview vhost to serve the PR container under (`pr-42-<slug>.<PREVIEW_BASE_URL>`) */
  previewDomain?: string;
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
    envPassthrough?: Record<string, string[]>;
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

/** Close a host port we opened for a container that no longer exists (blue-green retire). */
export async function closeFirewallPort(
  ssh: SSHClient,
  port: number,
  onProgress: (message: string) => void,
): Promise<void> {
  const script =
    `if command -v ufw >/dev/null 2>&1; then ` +
    `(ufw delete allow ${port}/tcp 2>&1 || sudo ufw delete allow ${port}/tcp 2>&1) >/dev/null 2>&1; echo PUSHIFY_FW=ufw; ` +
    `elif command -v firewall-cmd >/dev/null 2>&1; then ` +
    `(firewall-cmd --permanent --remove-port=${port}/tcp 2>&1 || sudo firewall-cmd --permanent --remove-port=${port}/tcp 2>&1) >/dev/null 2>&1; ` +
    `(firewall-cmd --reload 2>&1 || sudo firewall-cmd --reload 2>&1) >/dev/null 2>&1; echo PUSHIFY_FW=firewalld; ` +
    `elif command -v iptables >/dev/null 2>&1; then ` +
    `(iptables -D INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || sudo iptables -D INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null); echo PUSHIFY_FW=iptables; ` +
    `else echo PUSHIFY_FW=none; fi`;

  await ssh.exec(script);
  onProgress(`🔒 Firewall port ${port} closed`);
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
async function getPrimaryDomain(projectId: string, environment: 'production' | 'staging' = 'production'): Promise<string | null> {
  const domain = await db.query.domains.findFirst({
    where: and(eq(domains.projectId, projectId), eq(domains.environment, environment)),
    orderBy: (domains, { desc }) => [desc(domains.isPrimary)],
  });

  return domain?.domain || null;
}

/**
 * Point the project's whole vhost (every domain, www / apex counterparts included) at the new
 * container and get missing certificates. Returns whether the primary domain is on HTTPS.
 */
async function configureProjectDomains(
  ssh: SSHClient,
  input: {
    projectId: string;
    projectSlug: string;
    hostPort: number;
    serverIp: string | null;
    serverId: string;
    primaryDomain: string;
    environment?: 'production' | 'staging';
    /** Every replica's port; nginx balances across them when there is more than one */
    containerPorts?: number[];
    onProgress: (msg: string) => void;
  },
): Promise<boolean> {
  input.onProgress("🌐 Configuring Nginx for the project's domains...");
  const sync = await syncProjectSites(ssh, {
    projectId: input.projectId,
    projectSlug: input.projectSlug,
    environment: input.environment ?? 'production',
    containerPort: input.hostPort,
    containerPorts: input.containerPorts,
    serverIp: input.serverIp,
    requestCertificates: true,
    sharedHost: isSharedRunnerServer(input.serverId),
    onProgress: input.onProgress,
  });
  if (!sync.success) {
    input.onProgress(`⚠️ Nginx config warning: ${sync.message}`);
    return false;
  }
  input.onProgress(`✅ Nginx configured: ${describeSyncedDomains(sync.domains)}`);
  return sync.domains.find((d) => d.domain === input.primaryDomain)?.ssl ?? false;
}

/**
 * The Docker network the app should run on so it reaches Pushify databases by container name
 * (`pushify-db-<name>`), or undefined when there is nothing to reach. Never on the shared
 * runner: one network there would put every customer's containers next to each other.
 * Existing database containers (created before they started on this network) are joined here.
 */
async function prepareDatabaseNetwork(
  ssh: SSHClient,
  serverId: string,
  onProgress: (msg: string) => void,
): Promise<string | undefined> {
  if (isSharedRunnerServer(serverId)) return undefined;
  try {
    const dbList = await ssh.exec(`docker ps -a --format '{{.Names}}' | grep '^pushify-db-' || true`);
    const dbs = (dbList.stdout || '').trim().split('\n').map((s) => s.trim()).filter(Boolean);
    if (dbs.length === 0) return undefined;

    await ssh.exec(`docker network create ${DATABASE_NETWORK} 2>/dev/null || true`);
    for (const db of dbs) {
      await ssh.exec(`docker network connect ${DATABASE_NETWORK} ${shSingleQuote(db)} 2>/dev/null || true`);
    }
    onProgress(`🔗 Running on the '${DATABASE_NETWORK}' network — databases reachable by name (e.g. ${dbs[0]})`);
    return DATABASE_NETWORK;
  } catch {
    // best-effort — never break a deploy over network wiring
    return undefined;
  }
}

/**
 * Will nginx serve this deploy under a domain? Only then can a shared-runner app be published on
 * loopback. Without one — no custom domain, and no wildcard certificate here for an auto
 * subdomain — the app's URL is <server-ip>:<port>, which has to stay public. Deliberately looks
 * at domains that exist already: an auto subdomain created later in this deploy moves the app
 * behind nginx on its next deploy.
 */
async function servedThroughNginx(
  ssh: SSHClient,
  projectId: string,
  previewDomain: string | undefined,
  isPreview: boolean,
): Promise<boolean> {
  const { env: envConfig } = await import('../config/env');
  const previewBaseUrl = envConfig.PREVIEW_BASE_URL;
  const isAutoSubdomain = (d: string) => !!previewBaseUrl && d.endsWith(`.${previewBaseUrl}`);
  let hasWildcardSSL = false;
  if (previewBaseUrl) {
    const sslPath = envConfig.WILDCARD_SSL_PATH || `/etc/letsencrypt/live/${previewBaseUrl}`;
    hasWildcardSSL = (await ssh.exec(`test -f ${sslPath}/fullchain.pem && echo exists || echo missing`)).stdout.trim() === 'exists';
  }
  const domain = isPreview ? previewDomain ?? null : await getPrimaryDomain(projectId);
  if (!domain) return false;
  return !isAutoSubdomain(domain) || hasWildcardSSL;
}

/**
 * Auto subdomains resolve to the server that serves them through their own DNS record
 * (lib/cloudflare-dns.ts) — without one they fall to the zone's wildcard record, i.e. whatever
 * host that points at. Idempotent; never fails the deploy.
 */
async function ensureAutoSubdomainDns(names: string[], ip: string, onProgress: (msg: string) => void): Promise<void> {
  if (!cloudflareDnsConfigured()) return;
  for (const name of names) {
    try {
      const result = await ensureAutoSubdomainRecord(name, ip);
      if (result === 'created' || result === 'updated') onProgress(`🌍 DNS: ${name} → ${ip}`);
      if (result === 'foreign') onProgress(`⚠️ DNS: ${name} belongs to a record Pushify doesn't manage — left alone`);
    } catch (err) {
      onProgress(`⚠️ DNS record for ${name} could not be set: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * A domain-less app on a runner: point its fixed public port (nginx) at the container that just
 * passed its health check. On the first deploy behind the proxy the old container still publishes
 * that port itself, so it is retired first — a moment of downtime, once. Returns true when the old
 * container was retired here.
 */
async function pointPublicPort(
  ssh: SSHClient,
  slug: string,
  publicPort: number,
  containerPorts: number | number[],
  retireOldContainer: (() => Promise<void>) | null,
  onProgress: (msg: string) => void,
): Promise<boolean> {
  const written = await writePublicPortProxy(ssh, slug, publicPort, containerPorts);
  if (!written.success) throw new Error(`Could not route public port ${publicPort}: ${written.message}`);
  let retired = false;
  const holder = await containerHoldingPort(ssh, publicPort);
  if (holder) {
    if (!retireOldContainer) throw new Error(`Public port ${publicPort} is held by ${holder}`);
    onProgress(`🔀 Moving public port ${publicPort} from ${holder} to nginx`);
    await retireOldContainer();
    retired = true;
  }
  const reload = await reloadNginx(ssh);
  if (!reload.success) throw new Error(`Could not route public port ${publicPort}: ${reload.message}`);
  if (!(await publicPortAnswers(ssh, publicPort))) {
    throw new Error(`nginx is not answering on public port ${publicPort} after the reload`);
  }
  onProgress(
    `🔀 Public port ${publicPort} → new container${Array.isArray(containerPorts) && containerPorts.length > 1 ? 's' : ''} (127.0.0.1:${Array.isArray(containerPorts) ? containerPorts.join(', ') : containerPorts})`
  );
  return retired;
}

/**
 * Shared runner only: (re)apply the firewall rules that keep customers' containers away from each
 * other, from the host and from private networks (lib/runner-isolation.ts). Runs on every deploy,
 * so a rebooted or rebuilt runner is covered by its next deploy even without the boot unit.
 */
async function applyRunnerIsolation(ssh: SSHClient, onProgress: (msg: string) => void): Promise<void> {
  const result = await ssh.exec(applyRunnerIsolationCommand());
  if (result.stdout.includes('PUSHIFY_ISOLATION_OK')) {
    onProgress('🛡️ Shared-runner network isolation in place');
    const skipped = result.stdout.match(/PUSHIFY_ISOLATION_BUILDS_SKIPPED: (.*)/);
    if (skipped) {
      onProgress(`⚠️ Builds are not isolated: containers that aren't Pushify's use Docker's default bridge (${skipped[1].trim()})`);
    }
    const appNetsSkipped = result.stdout.match(/PUSHIFY_ISOLATION_APPNETS_SKIPPED: (.*)/);
    if (appNetsSkipped) {
      onProgress(`⚠️ Marketplace app networks are not isolated: containers that aren't Pushify's use them (${appNetsSkipped[1].trim()})`);
    }
  } else {
    onProgress(`⚠️ Could not apply shared-runner network isolation: ${(result.stderr || result.stdout).trim().slice(0, 300)}`);
    logger.warn({ stdout: result.stdout, stderr: result.stderr }, 'Shared-runner network isolation failed');
  }

  // Names nginx has no site for must not get another customer's site (see CATCH_ALL_TLS_SCRIPT).
  const catchAll = await ssh.exec(CATCH_ALL_TLS_SCRIPT);
  if (catchAll.stdout.includes('PUSHIFY_CATCHALL=added')) {
    await reloadNginx(ssh);
    onProgress('🛡️ Unknown host names on 443 are now refused instead of served another site');
  } else if (catchAll.stdout.includes('PUSHIFY_CATCHALL=rejected')) {
    logger.warn('Catch-all TLS server rejected by nginx -t on the shared runner');
  }
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

  let primaryServedOverHttp = false;
  if (primaryDomain) {
    primaryServedOverHttp = !(await configureProjectDomains(ssh, {
      projectId,
      projectSlug,
      hostPort,
      serverIp: server.ipv4,
      serverId: server.id,
      primaryDomain,
      onProgress,
    }));
  }

  if (primaryDomain) {
    return `${primaryServedOverHttp ? 'http' : 'https'}://${primaryDomain}`;
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
    frameworkForced = false,
    accessToken,
    onProgress,
    deploySuffix = '',
    previewDomain,
    environment = 'production',
    replicas: requestedReplicas = 1,
  } = config;
  // Previews stay single-container; production and staging can run several.
  const replicas = Math.max(1, Math.min(10, Math.round(requestedReplicas)));
  // A PR preview and a staging copy both run beside production; only a preview gets the
  // PR treatment (no domains of its own, no auto subdomain for the project).
  const isPreview = !!deploySuffix && environment !== 'staging';

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

    // One host for many customers: apps are published on loopback only (nginx is the way in)
    // and the isolation rules are re-applied before anything of this deploy runs.
    const sharedHost = isSharedRunnerServer(serverId);
    if (sharedHost) await applyRunnerIsolation(ssh, onProgress);

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

      // Sticky public port: reuse the project's previous port so the URL and firewall
      // rule survive redeploys. The old free-port scan ran while the previous stack was
      // still up, saw its own port as busy, and shifted the stack to a new port every
      // deploy. Previous port comes from the registry, or (pre-registry stacks) from
      // the PUSHIFY_PUBLIC_PORT recorded in the stack's .env on the last deploy.
      onProgress(`🔍 Resolving public host port...`);
      const prevPortResult = await ssh.exec(
        `grep -s '^PUSHIFY_PUBLIC_PORT=' ${projectDir}/.env | head -1 | cut -d= -f2`
      );
      const prevPort = parseInt(prevPortResult.stdout.trim(), 10);
      const { port: publicHostPort, isNew: portIsNew } = await getOrAssignPort(ssh, deploySlug, {
        range: { min: 5000, max: 5999 },
        preferredPort: isNaN(prevPort) ? undefined : prevPort,
      });
      const internalPort = config.marketplace.composePublicPort || 80;
      onProgress(
        `📌 ${portIsNew ? 'Assigned new' : 'Reusing'} host port: ${publicHostPort} → container ${internalPort}`
      );

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

      // Forward user env vars the template doesn't list (e.g. GOTRUE_*) to their services.
      // Compose auto-loads docker-compose.override.yml from the project dir; its
      // environment map merges over the template's, so user values win on collision.
      const overridePath = `${projectDir}/docker-compose.override.yml`;
      const envOverride = buildComposeEnvOverride(envVars, config.marketplace.envPassthrough);
      if (envOverride) {
        await ssh.uploadFile(envOverride.yaml, overridePath);
        for (const [service, keys] of Object.entries(envOverride.forwarded)) {
          onProgress(`🔧 Forwarding ${keys.length} env var(s) to '${service}': ${keys.join(', ')}`);
        }
      } else {
        await ssh.exec(`rm -f ${overridePath}`);
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
        await ssh.exec(
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

      // WordPress sits behind Pushify's TLS-terminating reverse proxy. Left alone it
      // saves the internal host:port it was first reached on (e.g. bizikimiz.com:3003)
      // as siteurl/home and then redirect-loops there. Derive the canonical URL from
      // the forwarded request at runtime instead; defining WP_HOME/WP_SITEURL as
      // constants also overrides any bad value already in the database, so an
      // already-broken site heals itself on the next deploy. Respect a user override.
      if (/(^|\/)wordpress(:|$)/i.test(dockerImage) && !envVars.WORDPRESS_CONFIG_EXTRA) {
        envVars.WORDPRESS_CONFIG_EXTRA = [
          "if (isset($_SERVER['HTTP_X_FORWARDED_PROTO']) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https') { $_SERVER['HTTPS'] = 'on'; $_SERVER['SERVER_PORT'] = 443; }",
          "$__pushify_host = isset($_SERVER['HTTP_HOST']) ? preg_replace('/:\\d+$/', '', $_SERVER['HTTP_HOST']) : '';",
          "if ($__pushify_host) { $__pushify_scheme = (isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] === 'on') ? 'https' : 'http'; define('WP_HOME', $__pushify_scheme . '://' . $__pushify_host); define('WP_SITEURL', $__pushify_scheme . '://' . $__pushify_host); }",
        ].join(' ');
        onProgress('🔧 WordPress reverse-proxy URL handling configured');
      }

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
      const networkFlag = requiresDb
        ? `--network ${networkName}`
        : sharedHost
          ? `--network ${RUNNER_APP_NETWORK}`
          : '';
      const loopbackOnly = sharedHost && (await servedThroughNginx(ssh, projectId, undefined, false));
      const runCmd = `docker run -d --name ${containerName} --restart unless-stopped${APP_CONTAINER_HARDENING} ${networkFlag} -p ${loopbackOnly ? '127.0.0.1:' : ''}${hostPort}:${containerPort} ${envFlags} ${volFlags} ${imageName}:latest${cmdOverride}`;

      onProgress(`🚀 Starting container: ${containerName}`);
      const runResult = await ssh.exec(runCmd);
      if (runResult.code !== 0) {
        throw new Error(`Failed to start container: ${runResult.stderr}`);
      }
      onProgress('✅ Container started');

      // Also join the Pushify database network (the app keeps its own network for its bundled db).
      const databaseNetwork = await prepareDatabaseNetwork(ssh, serverId, onProgress);
      if (databaseNetwork) {
        await ssh.exec(`docker network connect ${databaseNetwork} ${containerName} 2>/dev/null || true`);
      }

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
      cloneUrl = repoUrl.replace('https://', `https://x-access-token:${accessToken}@`);
    } else if (accessToken && repoUrl.includes('gitlab')) {
      try {
        const parsed = new URL(repoUrl);
        cloneUrl = `${parsed.protocol}//oauth2:${accessToken}@${parsed.host}${parsed.pathname}`;
      } catch {
        cloneUrl = repoUrl.replace('https://', `https://oauth2:${accessToken}@`);
      }
    }

    // Every value single-quoted and `--` before the URL: these came from the customer and this
    // runs as root (a branch like `x;curl …|sh` or a URL with `$(…)` used to execute).
    const cloneCmd =
      `git clone --depth 1 ${branch ? `--branch=${shSingleQuote(branch)} ` : ''}` +
      `-- ${shSingleQuote(cloneUrl)} ${shSingleQuote(repoDir)}`;

    const cloneResult = await ssh.exec(cloneCmd);
    if (cloneResult.code !== 0) {
      throw new Error(`Failed to clone repository: ${redactUrlCredentials(cloneResult.stderr)}`);
    }
    // git writes the clone URL — token included — into .git/config. Anything that later copies
    // the checkout (a static site's web root did) would publish it; keep only the clean URL.
    if (cloneUrl !== repoUrl) {
      const scrub = await ssh.exec(`git -C ${shSingleQuote(repoDir)} remote set-url origin ${shSingleQuote(repoUrl)}`);
      if (scrub.code !== 0) {
        await ssh.exec(`rm -rf ${shSingleQuote(repoDir)}`);
        throw new Error('Could not remove the access token from the cloned repository');
      }
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
      const { detectBuildpackRemote, detectNextStandaloneRemote, getBuildpack, buildpackIdForFramework } =
        await import('../buildpacks');

      const pinnedBuildpackId = frameworkForced && frameworkHint ? buildpackIdForFramework(frameworkHint) : null;
      let detection: { buildpackId: string; framework: string; confidence: number } | null;
      if (pinnedBuildpackId && frameworkHint) {
        // pushify.yaml `framework:` wins over whatever the repo layout suggests (a Laravel app
        // with a package.json used to be built as Node).
        onProgress(`📌 Framework set by pushify.yaml: ${frameworkHint}`);
        detection = { buildpackId: pinnedBuildpackId, framework: frameworkHint, confidence: 100 };
      } else {
        onProgress('🔍 Auto-detecting language and framework...');
        detection = await detectBuildpackRemote(ssh, repoDir, rootDirectory);
      }
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
    // Set by the blue-green step; runs after nginx points at the new container.
    let retireOldContainer: (() => Promise<void>) | null = null;
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

    // Blue-green, for real: the new container gets its own host port, is health-checked
    // there, nginx is re-pointed at it (a reload, no dropped requests) and only then is the
    // old container retired. The previous switch stopped the old container, then stopped and
    // re-created the new one on the production port — a full cold start of downtime on every
    // deploy, and the container that survived was not the one that had passed the check.
    onProgress('🔵🟢 Starting blue-green deployment...');
    const previousHostPort = hostPort;
    // Started on its network, not joined to it afterwards: an app that connects (or migrates)
    // at boot would otherwise race the join. On a runner that is the isolated apps network.
    const appNetwork = sharedHost ? RUNNER_APP_NETWORK : await prepareDatabaseNetwork(ssh, serverId, onProgress);
    const servedByDomain = await servedThroughNginx(ssh, projectId, previewDomain, !!deploySuffix);
    const loopbackOnly = sharedHost && servedByDomain;
    // A domain-less app keeps one public port across deploys, held by nginx
    // (workers/public-port-proxy.ts); its container is on loopback. Where nginx can't hold it
    // (not running, no sites-enabled, SELinux), the container publishes its port as before.
    const publicPort =
      !servedByDomain && !deploySuffix && (await canServePublicPort(ssh))
        ? await resolvePublicPort(ssh, deploySlug, hostPort)
        : null;
    const switchPort = await pickSwitchPort(ssh, hostPort, undefined, publicPort ? [publicPort] : []);

    const blueGreenResult = await blueGreenDeploy(ssh, {
      imageName: `${imageName}:${imageTag}`,
      containerName: `pushify-${deploySlug}`,
      hostPort,
      tempPort: switchPort,
      containerPort,
      envVars,
      volumes: config.volumes,
      networkMode: appNetwork,
      bindAddress: loopbackOnly || publicPort ? '127.0.0.1' : undefined,
      restart: 'unless-stopped',
      healthCheckTimeout: 60, // 60 seconds to become healthy
      framework: resolvedFramework,
      buildpackId: resolvedBuildpackId,
      onProgress,
    });

    if (!blueGreenResult.success) {
      throw new Error(`Blue-green deployment failed:\n${blueGreenResult.logs}`);
    }

    // The health-checked container is the one that stays; it now owns the project's port.
    hostPort = blueGreenResult.tempPort ?? switchPort;
    await recordPortAssignment(ssh, deploySlug, hostPort);

    // More than one replica: the rest start beside it, each on its own port, and nginx
    // balances across all of them (nginx-manager's upstream).
    const containerPorts = [hostPort];
    if (replicas > 1 && blueGreenResult.newContainerName) {
      const slot = blueGreenResult.newContainerName.endsWith('-blue') ? 'blue' : 'green';
      const extraPorts = await pickFreePorts(ssh, replicas - 1, [hostPort, ...(publicPort ? [publicPort] : [])]);
      onProgress(`👥 Starting ${replicas - 1} more replica(s)...`);
      const extra = await startExtraReplicas(ssh, {
        imageName: `${imageName}:${imageTag}`,
        containerName: `pushify-${deploySlug}`,
        hostPort,
        containerPort,
        envVars,
        volumes: config.volumes,
        networkMode: appNetwork,
        bindAddress: loopbackOnly || publicPort ? '127.0.0.1' : undefined,
        framework: resolvedFramework,
        buildpackId: resolvedBuildpackId,
        replicaPorts: extraPorts,
        slot,
        onProgress,
      });
      if (!extra.success) {
        await ssh.exec(`docker rm -f ${blueGreenResult.newContainerName} 2>/dev/null || true`);
        throw new Error(`Replicas failed to start:\n${extra.logs}`);
      }
      containerPorts.push(...extraPorts);
      for (const [index, port] of extraPorts.entries()) {
        await recordPortAssignment(ssh, `${deploySlug}#${index + 2}`, port);
        if (!loopbackOnly && !publicPort) await openFirewallPort(ssh, port, onProgress);
      }
    }

    if (blueGreenResult.oldContainerName) {
      const oldContainerName = blueGreenResult.oldContainerName;
      const oldSlot = oldContainerName.endsWith('-blue') ? 'blue' : 'green';
      const retireSsh = ssh; // narrowed here; the closure runs before the connection is released
      retireOldContainer = async () => {
        onProgress(`🗑️ Retiring old container: ${oldContainerName}`);
        await retireSsh.exec(`docker rm -f ${oldContainerName} 2>/dev/null || true`);
        // …and the replicas of that slot, however many it had (the count may have changed)
        await retireSsh.exec(
          `docker ps -aq --filter name='^pushify-${deploySlug}-${oldSlot}-[0-9]+$' | xargs -r docker rm -f 2>/dev/null || true`
        );
        if (previousHostPort !== hostPort && previousHostPort !== publicPort) {
          await closeFirewallPort(retireSsh, previousHostPort, onProgress);
        }
      };
    }
    onProgress(
      replicas > 1
        ? `✅ ${replicas} replicas healthy on ports ${containerPorts.join(', ')}`
        : `✅ New container healthy on port ${hostPort}`
    );

    // Open firewall port for external access (root-first; works on BYOS without sudo/ufw).
    // Not when the port is on loopback: then nginx is the only way in.
    if (publicPort) {
      await openFirewallPort(ssh, publicPort, onProgress);
      if (await pointPublicPort(ssh, deploySlug, publicPort, containerPorts, retireOldContainer, onProgress)) {
        retireOldContainer = null;
      }
    } else {
      if (loopbackOnly) {
        onProgress(`🔒 Port ${hostPort} is bound to 127.0.0.1 — reachable through nginx only`);
      } else {
        await openFirewallPort(ssh, hostPort, onProgress);
      }
      if (servedByDomain && !deploySuffix) {
        // Served under a domain now: a public port it had while it had none goes away.
        const formerPublicPort = await removePublicPortProxy(ssh, deploySlug);
        if (formerPublicPort) {
          await reloadNginx(ssh);
          await closeFirewallPort(ssh, formerPublicPort, onProgress);
          onProgress(`🔒 Public port ${formerPublicPort} closed — the app is served under its domain`);
        }
      }
    }

    // Worker processes run from the same image — production deploys only, never previews.
    if (!deploySuffix) {
      await syncWorkerContainersOnDeploy(ssh, {
        projectId,
        slug: deploySlug,
        imageRef: `${imageName}:${imageTag}`,
        envVars,
        volumes: config.volumes,
        networkMode: appNetwork,
        framework: resolvedFramework,
        buildpackId: resolvedBuildpackId,
        onProgress,
      });
    }

    // Check if project has any domains; if not, create auto subdomain (only on managed servers)
    // A preview deploy (deploySuffix) must never touch the project's domains: this block would
    // repoint the primary domain's vhost at the PR container's port, and a project without a
    // domain would get its production auto-subdomain created for the preview.
    let primaryDomain = isPreview ? null : await getPrimaryDomain(projectId, environment);

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
      onProgress(`🌐 Auto subdomain ${primaryDomain} only works on Pushify's shared host — this is your own server. Serving via http://${server.ipv4}:${publicPort ?? hostPort}`);
      try {
        await db.delete(domains).where(and(eq(domains.projectId, projectId), eq(domains.isAutoGenerated, true)));
      } catch (err) {
        onProgress(`⚠️ Could not remove stale auto subdomain record: ${err instanceof Error ? err.message : 'unknown'}`);
      }
      primaryDomain = null;
    }

    if (!primaryDomain && !isPreview) {
      if (previewBaseUrl && hasWildcardSSL) {
        onProgress('🌐 No domain configured, creating auto subdomain...');
        try {
          const autoDomain = await domainService.createAutoSubdomain(projectId, deploySlug, serverId, environment);
          if (autoDomain) {
            primaryDomain = autoDomain.domain;
            onProgress(`✅ Auto subdomain created: ${primaryDomain}`);
          }
        } catch (autoSubError) {
          onProgress(`⚠️ Auto subdomain creation warning: ${autoSubError instanceof Error ? autoSubError.message : 'Unknown error'}`);
        }
      } else {
        onProgress(`🌐 No domain configured. Access via: http://${server.ipv4}:${publicPort ?? hostPort}`);
      }
    }

    // Configure Nginx for every domain of the project (not only the primary one)
    if (primaryDomain) {
      await configureProjectDomains(ssh, {
        projectId,
        projectSlug: deploySlug,
        environment,
        hostPort,
        containerPorts,
        serverIp: server.ipv4,
        serverId: server.id,
        primaryDomain,
        onProgress,
      });
    }
    if (hasWildcardSSL && !isPreview && server.ipv4) {
      const autoDomains = await db
        .select({ domain: domains.domain })
        .from(domains)
        .where(
          and(
            eq(domains.projectId, projectId),
            eq(domains.isAutoGenerated, true),
            eq(domains.environment, environment)
          )
        );
      await ensureAutoSubdomainDns(autoDomains.map((d) => d.domain), server.ipv4, onProgress);
    }

    // PR preview: its own `pr-N-<slug>.<preview base>` vhost on the wildcard cert, so the URL
    // posted to the PR actually resolves. Never touches the project's own domains. Without the
    // wildcard cert (a person's own server) the preview stays on its IP:port.
    let previewVhostUrl: string | null = null;
    if (isPreview && previewDomain) {
      if (isPushifyAutoSubdomain(previewDomain) && hasWildcardSSL) {
        onProgress(`🌐 Configuring Nginx for preview: ${previewDomain}`);
        const addResult = await addAutoSubdomainSite(ssh, {
          domain: previewDomain,
          containerPort: hostPort,
          projectSlug: deploySlug,
        });
        if (!addResult.success) {
          onProgress(`⚠️ Preview nginx warning: ${addResult.message}`);
        } else {
          const reloadResult = await reloadNginx(ssh);
          if (!reloadResult.success) {
            onProgress(`⚠️ Nginx reload warning: ${reloadResult.message}`);
          } else {
            previewVhostUrl = `https://${previewDomain}`;
            if (server.ipv4) await ensureAutoSubdomainDns([previewDomain], server.ipv4, onProgress);
            onProgress(`✅ Preview reachable at ${previewVhostUrl}`);
          }
        }
      } else {
        onProgress(
          `🌐 ${previewDomain} needs the *.${previewBaseUrl || 'preview'} wildcard certificate, which this server does not have — preview served via http://${server.ipv4}:${hostPort}`
        );
      }
    }

    // Only now — nginx already points at the new container — take the old one down.
    if (retireOldContainer) {
      await retireOldContainer();
      onProgress('✅ Zero-downtime deployment successful');
    }

    // Determine deployment URL
    let deploymentUrl: string;
    if (primaryDomain) {
      deploymentUrl = `https://${primaryDomain}`;
    } else if (previewVhostUrl) {
      deploymentUrl = previewVhostUrl;
    } else {
      deploymentUrl = `http://${server.ipv4}:${publicPort ?? hostPort}`;
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
  /** Persistent named-volume mounts (name:containerPath) */
  volumes?: string[];
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
    const sharedHost = isSharedRunnerServer(serverId);
    if (sharedHost) await applyRunnerIsolation(ssh, onProgress);

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

    // Same switch as a deploy: the rollback image starts in the other slot on its own port, is
    // health-checked, nginx is re-pointed, then the current slot is retired. It used to start
    // `pushify-<slug>` on the project's port — held by the active blue/green slot, so a rollback
    // after any blue-green deploy failed with "port is already allocated", and nginx was never
    // re-pointed anyway.
    onProgress(`🔵🟢 Rolling back to ${fullImageName} (blue-green)...`);
    const previousHostPort = hostPort;
    const appNetwork = sharedHost ? RUNNER_APP_NETWORK : await prepareDatabaseNetwork(ssh, serverId, onProgress);
    const servedByDomain = await servedThroughNginx(ssh, projectId, undefined, false);
    const loopbackOnly = sharedHost && servedByDomain;
    const publicPort =
      !servedByDomain && (await canServePublicPort(ssh)) ? await resolvePublicPort(ssh, projectSlug, hostPort) : null;
    const switchPort = await pickSwitchPort(ssh, hostPort, undefined, publicPort ? [publicPort] : []);
    const blueGreenResult = await blueGreenDeploy(ssh, {
      imageName: fullImageName,
      containerName: `pushify-${projectSlug}`,
      hostPort,
      tempPort: switchPort,
      containerPort,
      envVars,
      volumes: config.volumes,
      networkMode: appNetwork,
      bindAddress: loopbackOnly || publicPort ? '127.0.0.1' : undefined,
      restart: 'unless-stopped',
      healthCheckTimeout: 60,
      onProgress,
    });
    if (!blueGreenResult.success) {
      throw new Error(`Rollback failed:\n${blueGreenResult.logs}`);
    }
    hostPort = blueGreenResult.tempPort ?? switchPort;
    await recordPortAssignment(ssh, projectSlug, hostPort);
    onProgress(`✅ Rollback container healthy on port ${hostPort}`);
    const oldContainerName = blueGreenResult.oldContainerName;
    let oldRetired = false;
    if (publicPort) {
      await openFirewallPort(ssh, publicPort, onProgress);
      const retireOld = oldContainerName
        ? async () => {
            await ssh!.exec(`docker rm -f ${oldContainerName} 2>/dev/null || true`);
          }
        : null;
      oldRetired = await pointPublicPort(ssh, projectSlug, publicPort, hostPort, retireOld, onProgress);
    } else if (!loopbackOnly) {
      await openFirewallPort(ssh, hostPort, onProgress);
    }

    // Restart worker processes from the rollback image so app + workers stay in sync
    await syncWorkerContainersOnDeploy(ssh, {
      projectId,
      slug: projectSlug,
      imageRef: fullImageName,
      envVars,
      volumes: config.volumes,
      networkMode: appNetwork,
      onProgress,
    });

    // Update latest tag to point to rollback image
    await tagImage(ssh, fullImageName, `${imageName}:latest`);
    onProgress(`🏷️ Updated latest tag to ${deploymentTag}`);

    // Point the project's domains at the rollback container, then retire the current slot
    const primaryDomain = await getPrimaryDomain(projectId);
    let primaryOnHttps = true;
    if (primaryDomain) {
      primaryOnHttps = await configureProjectDomains(ssh, {
        projectId,
        projectSlug,
        hostPort,
        serverIp: server.ipv4,
        serverId: server.id,
        primaryDomain,
        onProgress,
      });
    }
    if (oldContainerName) {
      if (!oldRetired) {
        onProgress(`🗑️ Retiring old container: ${oldContainerName}`);
        await ssh.exec(`docker rm -f ${oldContainerName} 2>/dev/null || true`);
      }
      if (previousHostPort !== hostPort && previousHostPort !== publicPort) {
        await closeFirewallPort(ssh, previousHostPort, onProgress);
      }
    }

    const deploymentUrl = primaryDomain
      ? `${primaryOnHttps ? 'https' : 'http'}://${primaryDomain}`
      : `http://${server.ipv4}:${publicPort ?? hostPort}`;

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
