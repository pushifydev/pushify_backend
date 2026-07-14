import { HTTPException } from 'hono/http-exception';
import { eq, and, desc, count, ne, inArray } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { projects } from '../db/schema/projects';
import { databases } from '../db/schema/databases';
import { deployments } from '../db/schema/deployments';
import type { ServerSize } from '../providers/cloud-provider.interface';
import { organizationRepository } from '../repositories/organization.repository';
import { organizations } from '../db/schema/organizations';
import { createProvider, type ProviderType, type ServerConfig } from '../providers';
import { t, type SupportedLocale } from '../i18n';
import { getServerStatusQueue } from '../queue';
import { generateSSHKeyPair } from '../utils/ssh';
import { encrypt, decrypt } from '../lib/encryption';
import { type PlanType } from '../lib/plans';
import { getEffectivePlanLimits } from '../lib/effective-plan-limits';
import { usageMeteringService } from './usage-metering.service';
import { planLimitsService } from './plan-limits.service';
import { getPlanInfraLimits, minimumBalanceToStartCents} from '../lib/infra-billing';
import { infraBillingService } from './infra-billing.service';
import { assertOrganizationCanMutateResources } from './organization-billing.service';
import { SSHClient } from '../utils/ssh';
import { wsManager } from '../lib/ws';
import { logger } from '../lib/logger';
import { adminNotify } from './admin-notify.service';

export interface CreateServerInput {
  name: string;
  description?: string;
  provider: ProviderType;
  region: string;
  size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'custom';
  image: string;
  sshKeyIds?: string[];
  labels?: Record<string, string>;
  // BYOS fields
  ipv4?: string;
  sshPrivateKey?: string;
  rootPassword?: string;
  authMethod?: 'ssh_key' | 'password';
}

// Cloud-init script for automatic software installation
// Order: Docker first, then Nginx with health endpoint, then Certbot
const CLOUD_INIT_SCRIPT = `#!/bin/bash

# Log everything to file
exec > /var/log/pushify-setup.log 2>&1

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"
}

log "Starting Pushify setup..."

# Wait for cloud-init to complete and system to be ready
log "Waiting for system to be ready..."
sleep 15

# Wait for apt lock to be released (other processes might be using apt)
wait_for_apt() {
    local max_attempts=30
    local attempt=0
    while fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1 || fuser /var/lib/apt/lists/lock >/dev/null 2>&1; do
        attempt=$((attempt + 1))
        if [ $attempt -ge $max_attempts ]; then
            log "WARNING: Apt lock wait timeout, proceeding anyway"
            break
        fi
        log "Waiting for apt lock to be released... (attempt $attempt/$max_attempts)"
        sleep 10
    done
}

# Create directories
log "Creating directories..."
mkdir -p /opt/pushify/{apps,nginx,ssl,logs}

# Non-interactive apt
export DEBIAN_FRONTEND=noninteractive

# Wait for apt and update
wait_for_apt
log "Updating package lists..."
apt-get update -y

# Configure firewall FIRST (before installing services)
log "Configuring firewall..."
wait_for_apt
apt-get install -y ufw
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
log "Firewall configured"

# STEP 1: Install Docker FIRST (as requested)
log "Installing Docker..."
wait_for_apt
apt-get install -y ca-certificates curl gnupg

# Add Docker's official GPG key
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# Add Docker repository
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null

wait_for_apt
apt-get update -y

wait_for_apt
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Start and enable Docker
systemctl enable docker
systemctl start docker
log "Docker installed and running"

# Verify Docker is working
if docker --version; then
    log "Docker version: $(docker --version)"
else
    log "WARNING: Docker installation may have issues"
fi

# STEP 2: Install Nginx
log "Installing Nginx..."
wait_for_apt
apt-get install -y nginx

# Configure nginx with health endpoint
log "Configuring Nginx..."
cat > /etc/nginx/sites-available/default << 'SITE'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    location /health {
        return 200 'OK';
        add_header Content-Type text/plain;
    }

    location / {
        return 200 'Pushify Server Ready';
        add_header Content-Type text/plain;
    }
}
SITE

# Ensure symlink exists
ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
rm -f /etc/nginx/sites-enabled/default.bak 2>/dev/null || true

# Configure main nginx.conf
cat > /etc/nginx/nginx.conf << 'NGINXCONF'
user www-data;
worker_processes auto;
pid /run/nginx.pid;
include /etc/nginx/modules-enabled/*.conf;

events {
    worker_connections 1024;
    multi_accept on;
}

http {
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    server_tokens off;

    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    access_log /var/log/nginx/access.log;
    error_log /var/log/nginx/error.log;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;

    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers on;

    include /etc/nginx/conf.d/*.conf;
    include /etc/nginx/sites-enabled/*;
}
NGINXCONF

# Test and restart nginx
if nginx -t; then
    systemctl enable nginx
    systemctl restart nginx
    log "Nginx configured and running"
else
    log "ERROR: Nginx configuration test failed"
fi

# STEP 3: Install Certbot
log "Installing Certbot..."
wait_for_apt
apt-get install -y certbot python3-certbot-nginx
log "Certbot installed"

# Create pushify user and add to docker group
log "Creating pushify user..."
useradd -m -s /bin/bash pushify 2>/dev/null || true
usermod -aG docker pushify 2>/dev/null || true

# Verify services are running
log "Verifying services..."
systemctl is-active --quiet docker && log "Docker: running" || log "Docker: NOT running"
systemctl is-active --quiet nginx && log "Nginx: running" || log "Nginx: NOT running"

# Test health endpoint locally
if curl -s http://localhost/health | grep -q "OK"; then
    log "Health endpoint: responding correctly"
else
    log "WARNING: Health endpoint not responding as expected"
fi

# Mark setup as complete
touch /opt/pushify/.setup-complete
log "Pushify setup completed successfully!"
`;

export interface ServerLocation {
  city: string;
  country: string;
  latitude: number;
  longitude: number;
  datacenter?: string;
}

export interface ServerInfraBillingDetails {
  walletBalanceCents: number;
  requiredStartCents: number;
  estimatedMonthlyCents: number;
  canStart: boolean;
}

export interface ServerWithDetails {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  providerId: string | null;
  region: string;
  size: string;
  image: string | null;
  vcpus: number;
  memoryMb: number;
  diskGb: number;
  ipv4: string | null;
  ipv6: string | null;
  privateIp: string | null;
  status: string;
  setupStatus: string;
  statusMessage: string | null;
  labels: Record<string, unknown>;
  location: ServerLocation | null;
  projectCount: number;
  databaseCount: number;
  isManaged: boolean;
  autoSnapshotEnabled: boolean;
  lastAutoSnapshotAt: Date | null;
  infraBilling?: ServerInfraBillingDetails;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
}

function extractServerLocation(providerData: unknown): ServerLocation | null {
  if (!providerData || typeof providerData !== 'object') return null;
  const pd = providerData as {
    location?: {
      city?: string;
      country?: string;
      latitude?: number;
      longitude?: number;
      name?: string;
    };
    datacenter?: string;
  };
  const loc = pd.location;
  if (typeof loc?.latitude === 'number' && typeof loc?.longitude === 'number') {
    return {
      city: loc.city || loc.name || '',
      country: loc.country || '',
      latitude: loc.latitude,
      longitude: loc.longitude,
      datacenter: pd.datacenter,
    };
  }
  return null;
}

type ServerRow = typeof servers.$inferSelect;

async function getServerUsageCounts(organizationId: string, serverIds: string[]) {
  const projectCountMap = new Map<string, number>();
  const databaseCountMap = new Map<string, number>();

  if (serverIds.length === 0) {
    return { projectCountMap, databaseCountMap };
  }

  const [projectRows, databaseRows] = await Promise.all([
    db
      .select({ serverId: projects.serverId, count: count() })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, organizationId),
          ne(projects.status, 'deleted'),
          inArray(projects.serverId, serverIds)
        )
      )
      .groupBy(projects.serverId),
    db
      .select({ serverId: databases.serverId, count: count() })
      .from(databases)
      .where(
        and(
          eq(databases.organizationId, organizationId),
          inArray(databases.serverId, serverIds)
        )
      )
      .groupBy(databases.serverId),
  ]);

  for (const row of projectRows) {
    if (row.serverId) projectCountMap.set(row.serverId, row.count);
  }
  for (const row of databaseRows) {
    if (row.serverId) databaseCountMap.set(row.serverId, row.count);
  }

  return { projectCountMap, databaseCountMap };
}

function mapServerRow(
  s: ServerRow,
  projectCountMap: Map<string, number>,
  databaseCountMap: Map<string, number>,
  overrides?: Partial<Pick<ServerWithDetails, 'statusMessage'>>
): ServerWithDetails {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    provider: s.provider,
    providerId: s.providerId,
    region: s.region,
    size: s.size,
    image: s.image,
    vcpus: s.vcpus,
    memoryMb: s.memoryMb,
    diskGb: s.diskGb,
    ipv4: s.ipv4,
    ipv6: s.ipv6,
    privateIp: s.privateIp,
    status: s.status,
    setupStatus: s.setupStatus,
    statusMessage: s.statusMessage,
    labels: s.labels as Record<string, unknown>,
    location: extractServerLocation(s.providerData),
    projectCount: projectCountMap.get(s.id) ?? 0,
    databaseCount: databaseCountMap.get(s.id) ?? 0,
    isManaged: s.isManaged,
    autoSnapshotEnabled: s.autoSnapshotEnabled,
    lastAutoSnapshotAt: s.lastAutoSnapshotAt,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastSeenAt: s.lastSeenAt,
    ...overrides,
  };
}

async function toServerDetails(
  s: ServerRow,
  organizationId: string,
  overrides?: Partial<Pick<ServerWithDetails, 'statusMessage'>>
): Promise<ServerWithDetails> {
  const { projectCountMap, databaseCountMap } = await getServerUsageCounts(organizationId, [s.id]);
  return mapServerRow(s, projectCountMap, databaseCountMap, overrides);
}

// Get provider API token from organization settings or env
const SIZE_RANK: Record<ServerSize, number> = {
  xs: 0,
  sm: 1,
  md: 2,
  lg: 3,
  xl: 4,
  custom: 5,
};

function isUpgradeSize(current: ServerSize, next: ServerSize): boolean {
  return SIZE_RANK[next] > SIZE_RANK[current];
}

function specsScore(vcpus: number, memoryMb: number): number {
  return vcpus * 1_000_000 + memoryMb;
}

function getProviderToken(provider: ProviderType): string {
  // For now, use environment variables
  // In the future, this could be per-organization credentials (BYOC)
  switch (provider) {
    case 'hetzner':
      return process.env.HETZNER_API_TOKEN || '';
    case 'digitalocean':
      return process.env.DIGITALOCEAN_API_TOKEN || '';
    case 'aws':
      return process.env.AWS_ACCESS_KEY || '';
    default:
      throw new Error(`No API token configured for provider: ${provider}`);
  }
}

export const serverService = {
  /**
   * List all servers for an organization
   */
  async listServers(
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<ServerWithDetails[]> {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const result = await db
      .select()
      .from(servers)
      .where(eq(servers.organizationId, organizationId))
      .orderBy(desc(servers.createdAt));

    const { projectCountMap, databaseCountMap } = await getServerUsageCounts(
      organizationId,
      result.map((s) => s.id)
    );

    return result.map((s) => mapServerRow(s, projectCountMap, databaseCountMap));
  },

  /**
   * Get a single server by ID
   */
  async getServer(
    serverId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<ServerWithDetails> {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    await infraBillingService.clearInfraCreditsStoppedMessages(organizationId);

    const result = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!result[0]) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    const s = result[0];
    const { projectCountMap, databaseCountMap } = await getServerUsageCounts(organizationId, [
      s.id,
    ]);
    const row = mapServerRow(s, projectCountMap, databaseCountMap);
    const infraBilling = await infraBillingService.getServerInfraBillingContext(
      organizationId,
      serverId,
    );
    return infraBilling ? { ...row, infraBilling } : row;
  },

  /**
   * Create a new server
   */
  async createServer(
    organizationId: string,
    userId: string,
    input: CreateServerInput,
    locale: SupportedLocale = 'en'
  ): Promise<ServerWithDetails> {
    // Verify access - need admin or owner role
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    if (!['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    await assertOrganizationCanMutateResources(organizationId, locale);

    await planLimitsService.assertServersQuota(organizationId, locale);

    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'notFound') });
    }
    const plan = (org.plan || 'free') as PlanType;

    // ── BYOS (Bring Your Own Server) ──
    if (input.provider === 'self_hosted') {
      if (!input.ipv4) {
        throw new HTTPException(400, { message: 'IP address is required for self-hosted servers' });
      }

      // Generate SSH key pair
      const serverKeyName = `pushify-${organizationId.slice(0, 8)}-${Date.now()}`;
      const sshKeyPair = generateSSHKeyPair(serverKeyName);

      // Create server in database
      const [dbServer] = await db
        .insert(servers)
        .values({
          organizationId,
          name: input.name,
          description: input.description || null,
          provider: 'self_hosted',
          region: input.region || 'custom',
          size: input.size || 'custom',
          image: input.image || 'custom',
          ipv4: input.ipv4,
          status: 'running',
          setupStatus: 'pending',
          isManaged: false,
          labels: input.labels || {},
          sshPrivateKey: input.sshPrivateKey ? encrypt(input.sshPrivateKey) : encrypt(sshKeyPair.privateKey),
          sshPublicKey: sshKeyPair.publicKey,
          rootPassword: input.rootPassword ? encrypt(input.rootPassword) : null,
        })
        .returning();

      // Try to connect and setup the server in background
      this.setupBYOSServer(dbServer.id, {
        ipv4: input.ipv4,
        pushifyPublicKey: sshKeyPair.publicKey,
        userPrivateKey: input.sshPrivateKey,
        rootPassword: input.rootPassword,
      }).catch((err) => {
        logger.error({ err, serverId: dbServer.id }, 'BYOS server setup failed');
      });

      return toServerDetails(dbServer, organizationId, {
        statusMessage: 'Connecting to server...',
      });
    }

    // ── Managed provider flow ──
    const infraLimits = getPlanInfraLimits(plan);
    if (!infraLimits.managedServersEnabled) {
      throw new HTTPException(403, {
        message: t(locale, 'infraBilling', 'managedNotAllowed'),
      });
    }

    const quote = await infraBillingService.quoteManagedServer(
      plan,
      input.provider,
      input.region,
      input.size,
      locale,
    );
    await infraBillingService.assertWalletCanProvision(organizationId, plan, quote, locale);

    // Get provider token
    const apiToken = getProviderToken(input.provider);
    if (!apiToken) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'providerNotConfigured') });
    }

    // Create provider instance
    const provider = createProvider(input.provider, apiToken);

    // Generate SSH key pair for this server
    const serverKeyName = `pushify-${organizationId.slice(0, 8)}-${Date.now()}`;
    const sshKeyPair = generateSSHKeyPair(serverKeyName);

    // Upload public key to provider
    let providerSshKeyId: string | undefined;
    try {
      const uploadedKey = await provider.uploadSSHKey(serverKeyName, sshKeyPair.publicKey);
      providerSshKeyId = uploadedKey.id;
    } catch (error) {
      console.warn('Failed to upload SSH key to provider:', error);
      // Continue without SSH key - server will still be created with password auth
    }

    const billingFields = infraBillingService.billingFieldsFromQuote(quote);

    adminNotify('server.created', {
      server: input.name,
      type: 'managed',
      size: input.size,
      region: input.region,
      organizationId,
    });

    // Create server in database first (provisioning status)
    const [dbServer] = await db
      .insert(servers)
      .values({
        organizationId,
        name: input.name,
        description: input.description || null,
        provider: input.provider,
        region: input.region,
        size: input.size,
        image: input.image,
        status: 'provisioning',
        labels: input.labels || {},
        sshKeyId: providerSshKeyId || null,
        sshPrivateKey: encrypt(sshKeyPair.privateKey),
        sshPublicKey: sshKeyPair.publicKey,
        vcpus: quote.specs.vcpus,
        memoryMb: quote.specs.memoryMb,
        diskGb: quote.specs.diskGb,
        isManaged: true,
        ...billingFields,
      })
      .returning();

    try {
      // Create server with provider - use our generated SSH key
      const sshKeyIds = providerSshKeyId ? [providerSshKeyId] : input.sshKeyIds;

      const config: ServerConfig = {
        name: `${input.name}-${dbServer.id.slice(0, 8)}`,
        region: input.region,
        size: input.size,
        image: input.image,
        sshKeyIds,
        userData: CLOUD_INIT_SCRIPT,
        labels: {
          ...input.labels,
          pushify_server_id: dbServer.id,
          pushify_org_id: organizationId,
        },
      };

      const providerServer = await provider.createServer(config);

      // Update database with initial provider info
      const [updated] = await db
        .update(servers)
        .set({
          providerId: providerServer.providerId,
          providerData: providerServer.providerData,
          ipv4: providerServer.ipv4,
          ipv6: providerServer.ipv6,
          privateIp: providerServer.privateIp,
          vcpus: providerServer.vcpus,
          memoryMb: providerServer.memoryMb,
          diskGb: providerServer.diskGb,
          status: providerServer.status,
          updatedAt: new Date(),
        })
        .where(eq(servers.id, dbServer.id))
        .returning();

      // Add job to queue for background status polling
      const queue = getServerStatusQueue();
      await queue.add(
        `server-status-${dbServer.id}`,
        {
          serverId: dbServer.id,
          providerId: providerServer.providerId,
          provider: input.provider,
        },
        {
          jobId: `server-status-${dbServer.id}`,
          delay: 5000, // Start checking after 5 seconds
        }
      );

      return toServerDetails(updated, organizationId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Server creation failed:', errorMessage, error);

      // Update server status to error
      await db
        .update(servers)
        .set({
          status: 'error',
          statusMessage: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(servers.id, dbServer.id));

      // In development, show the actual error message
      const isDev = process.env.NODE_ENV === 'development';
      throw new HTTPException(500, {
        message: isDev ? `${t(locale, 'servers', 'createFailed')}: ${errorMessage}` : t(locale, 'servers', 'createFailed'),
      });
    }
  },

  /**
   * Delete a server
   */
  async deleteServer(
    serverId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<void> {
    // Verify access - need admin or owner role
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    if (!['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    // Get server
    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    // Update status to deleting
    await db
      .update(servers)
      .set({ status: 'deleting', updatedAt: new Date() })
      .where(eq(servers.id, serverId));

    try {
      // Delete from provider if managed
      if (server.isManaged && server.providerId) {
        const apiToken = getProviderToken(server.provider as ProviderType);
        const provider = createProvider(server.provider as ProviderType, apiToken);
        await provider.deleteServer(server.providerId);
      }

      // Delete from database
      await db.delete(servers).where(eq(servers.id, serverId));
      adminNotify('server.deleted', { server: server.name, organizationId });
    } catch (error) {
      // Revert status on error
      await db
        .update(servers)
        .set({
          status: 'error',
          statusMessage: error instanceof Error ? error.message : 'Delete failed',
          updatedAt: new Date(),
        })
        .where(eq(servers.id, serverId));

      throw new HTTPException(500, {
        message: t(locale, 'servers', 'deleteFailed'),
      });
    }
  },

  /**
   * Power actions (start, stop, reboot)
   */
  async powerAction(
    serverId: string,
    organizationId: string,
    userId: string,
    action: 'start' | 'stop' | 'reboot',
    locale: SupportedLocale = 'en'
  ): Promise<ServerWithDetails> {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Get server
    let [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    if (action === 'start') {
      await assertOrganizationCanMutateResources(organizationId, locale);
    }

    const providerId = server.providerId;
    if (!providerId) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
    }

    if (action === 'start' && server.isManaged && server.provider !== 'self_hosted') {
      const org = await organizationRepository.findById(organizationId);
      const plan = (org?.plan || 'free') as PlanType;

      if (plan !== 'enterprise') {
        if (!server.customerPriceMonthlyCents) {
          await infraBillingService.backfillServerBillingIfMissing(serverId);
          const [refreshed] = await db
            .select()
            .from(servers)
            .where(eq(servers.id, serverId))
            .limit(1);
          if (refreshed) server = refreshed;
        }

        // Restarting an existing server shouldn't demand a full month upfront —
        // require 72 hours of coverage; the hourly accrual handles the rest.
        const required = minimumBalanceToStartCents(server.customerPriceMonthlyCents ?? 0);
        if (required > 0) {
          const [orgWallet] = await db
            .select({ balance: organizations.infraWalletBalanceCents })
            .from(organizations)
            .where(eq(organizations.id, organizationId))
            .limit(1);

          if ((orgWallet?.balance ?? 0) < required) {
            throw new HTTPException(402, {
              message: t(locale, 'infraBilling', 'insufficientWallet'),
            });
          }
        }
      }
    }

    const apiToken = getProviderToken(server.provider as ProviderType);
    const provider = createProvider(server.provider as ProviderType, apiToken);

    // Execute action
    switch (action) {
      case 'start':
        await provider.powerOn(providerId);
        break;
      case 'stop':
        await provider.powerOff(providerId);
        break;
      case 'reboot':
        await provider.reboot(providerId);
        break;
    }

    // Update status; clear billing stop copy after a successful start
    const newStatus = action === 'reboot' ? 'rebooting' : action === 'start' ? 'running' : 'stopped';
    const [updated] = await db
      .update(servers)
      .set({
        // Starting resets the billing anchor so stopped time is never billed.
        ...(action === 'start'
          ? { infraLastChargedAt: new Date(), infraBillingCarryMillicents: 0 }
          : {}),
        status: newStatus,
        updatedAt: new Date(),
        ...(action === 'start' ? { statusMessage: null } : {}),
      })
      .where(eq(servers.id, serverId))
      .returning();

    return toServerDetails(updated, organizationId);
  },

  /**
   * Sync server status from provider
   */
  async syncServer(
    serverId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ): Promise<ServerWithDetails> {
    // Verify access
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Get server
    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    if (!server.providerId) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
    }

    const apiToken = getProviderToken(server.provider as ProviderType);
    const provider = createProvider(server.provider as ProviderType, apiToken);

    // Get server from provider
    const providerServer = await provider.getServer(server.providerId);

    const clearBillingStopMessage =
      providerServer.status === 'running' &&
      (server.statusMessage === 'infra_credits_stopped' ||
        server.statusMessage === 'billing_suspended');

    const providerData =
      server.provider === 'hetzner' && server.isManaged
        ? await usageMeteringService.mergeHetznerTrafficProviderData(
            organizationId,
            providerServer.providerData,
          )
        : providerServer.providerData;

    // Update database
    const [updated] = await db
      .update(servers)
      .set({
        ipv4: providerServer.ipv4,
        ipv6: providerServer.ipv6,
        privateIp: providerServer.privateIp,
        status: providerServer.status,
        vcpus: providerServer.vcpus,
        memoryMb: providerServer.memoryMb,
        diskGb: providerServer.diskGb,
        providerData,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
        ...(clearBillingStopMessage ? { statusMessage: null } : {}),
      })
      .where(eq(servers.id, serverId))
      .returning();

    return toServerDetails(updated, organizationId);
  },

  /**
   * Get available regions for a provider
   */
  async getRegions(provider: ProviderType, locale: SupportedLocale = 'en') {
    const apiToken = getProviderToken(provider);
    if (!apiToken) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'providerNotConfigured') });
    }

    const providerInstance = createProvider(provider, apiToken);
    return providerInstance.listRegions();
  },

  /**
   * Get available images for a provider
   */
  async getImages(provider: ProviderType, locale: SupportedLocale = 'en') {
    const apiToken = getProviderToken(provider);
    if (!apiToken) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'providerNotConfigured') });
    }

    const providerInstance = createProvider(provider, apiToken);
    return providerInstance.listImages();
  },

  /**
   * Get available sizes for a provider
   */
  async getSizes(provider: ProviderType, locale: SupportedLocale = 'en') {
    const apiToken = getProviderToken(provider);
    if (!apiToken) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'providerNotConfigured') });
    }

    const providerInstance = createProvider(provider, apiToken);
    return providerInstance.listSizes();
  },

  /**
   * Sizes with customer pricing, margin, and plan eligibility (for dashboard).
   */
  async getSizesForOrganization(
    organizationId: string,
    provider: ProviderType,
    region: string,
    locale: SupportedLocale = 'en',
  ) {
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'notFound') });
    }
    const plan = (org.plan || 'free') as PlanType;
    return infraBillingService.getSizedOptionsForOrganization(
      organizationId,
      plan,
      provider,
      region,
      locale,
    );
  },

  /**
   * Get available server types for a provider (raw types from provider)
   */
  async getServerTypes(provider: ProviderType, location?: string, locale: SupportedLocale = 'en') {
    const apiToken = getProviderToken(provider);
    if (!apiToken) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'providerNotConfigured') });
    }

    const providerInstance = createProvider(provider, apiToken);
    return providerInstance.listServerTypes(location);
  },

  /**
   * Setup a BYOS (Bring Your Own Server) — connect via SSH, install Docker + Nginx
   */
  async setupBYOSServer(
    serverId: string,
    input: {
      ipv4: string;
      pushifyPublicKey: string;
      userPrivateKey?: string;
      rootPassword?: string;
    },
  ): Promise<void> {
    const { ipv4, pushifyPublicKey, userPrivateKey, rootPassword } = input;
    let ssh: SSHClient | null = null;

    try {
      await db.update(servers).set({ setupStatus: 'installing', statusMessage: 'Connecting to server...' }).where(eq(servers.id, serverId));

      ssh = new SSHClient();
      const connectConfig: {
        host: string;
        port: number;
        username: string;
        privateKey?: string;
        password?: string;
      } = { host: ipv4, port: 22, username: 'root' };

      const trimmedKey = userPrivateKey?.trim();
      if (trimmedKey && trimmedKey.includes('BEGIN')) {
        connectConfig.privateKey = trimmedKey;
      } else if (rootPassword) {
        connectConfig.password = rootPassword;
      } else {
        throw new Error('BYOS setup requires root password or a valid SSH private key');
      }

      await ssh.connect(connectConfig);

      await db.update(servers).set({ statusMessage: 'Connected. Installing dependencies...' }).where(eq(servers.id, serverId));

      // Add Pushify public key to authorized_keys (idempotent)
      const escapedKey = pushifyPublicKey.replace(/'/g, `'\\''`);
      await ssh.exec(
        `mkdir -p ~/.ssh && chmod 700 ~/.ssh && touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && grep -qF '${escapedKey}' ~/.ssh/authorized_keys || echo '${escapedKey}' >> ~/.ssh/authorized_keys`,
      );

      // Check if Docker is installed
      const dockerCheck = await ssh.exec('docker --version');
      if (dockerCheck.code !== 0) {
        await db.update(servers).set({ statusMessage: 'Installing Docker...' }).where(eq(servers.id, serverId));
        await ssh.exec('curl -fsSL https://get.docker.com | sh');
        await ssh.exec('systemctl enable docker && systemctl start docker');
      }

      // Check if Nginx is installed
      const nginxCheck = await ssh.exec('nginx -v 2>&1');
      if (nginxCheck.code !== 0) {
        await db.update(servers).set({ statusMessage: 'Installing Nginx...' }).where(eq(servers.id, serverId));
        await ssh.exec('apt-get update -qq && apt-get install -y -qq nginx certbot python3-certbot-nginx > /dev/null 2>&1 || yum install -y nginx certbot python3-certbot-nginx > /dev/null 2>&1');
        await ssh.exec('systemctl enable nginx && systemctl start nginx');
      }

      // Create pushify directories
      await ssh.exec('mkdir -p /opt/pushify/apps /opt/pushify/nginx');

      // Get server specs
      const cpuResult = await ssh.exec('nproc');
      const memResult = await ssh.exec("free -m | awk '/^Mem:/{print $2}'");
      const diskResult = await ssh.exec("df -BG / | awk 'NR==2{print $2}' | tr -d 'G'");

      const vcpus = parseInt(cpuResult.stdout?.trim() || '0') || 1;
      const memoryMb = parseInt(memResult.stdout?.trim() || '0') || 512;
      const diskGb = parseInt(diskResult.stdout?.trim() || '0') || 10;

      // Update server as ready
      await db.update(servers).set({
        setupStatus: 'completed',
        statusMessage: 'Server setup completed successfully',
        status: 'running',
        vcpus,
        memoryMb,
        diskGb,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(servers.id, serverId));

      // Publish WebSocket event
      wsManager.publish(`server:${serverId}`, {
        type: 'server:status',
        data: { serverId, status: 'running', setupStatus: 'completed', ipv4 },
      }).catch(() => {});

      logger.info({ serverId, ipv4 }, 'BYOS server setup completed');
      adminNotify('server.created', { serverId, type: 'byos', ipv4 });

      // Notify the org owner that the server is ready (fire-and-forget, no locale here → 'en')
      void (async () => {
        try {
          const serverRecord = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
          if (!serverRecord) return;
          const { resolveBillingNotifyEmail } = await import('../lib/billing-notify');
          const { sendServerReadyEmail } = await import('../lib/email');
          const to = await resolveBillingNotifyEmail(serverRecord.organizationId);
          if (to) {
            await sendServerReadyEmail(to, serverRecord.name, serverId, 'en');
          }
        } catch {
          // best-effort
        }
      })();
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Setup failed';
      logger.error({ err: error, serverId }, 'BYOS server setup failed');

      await db.update(servers).set({
        setupStatus: 'failed',
        statusMessage: msg,
        updatedAt: new Date(),
      }).where(eq(servers.id, serverId));

      wsManager.publish(`server:${serverId}`, {
        type: 'server:status',
        data: { serverId, status: 'error', setupStatus: 'failed', ipv4 },
      }).catch(() => {});
    } finally {
      ssh?.disconnect();
    }
  },

  /**
   * Re-run BYOS setup after a failed attempt (uses stored root password unless new credentials are sent).
   */
  async retryByosSetup(
    serverId: string,
    organizationId: string,
    userId: string,
    credentials?: { rootPassword?: string; sshPrivateKey?: string },
    locale: SupportedLocale = 'en',
  ): Promise<ServerWithDetails> {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    if (server.provider !== 'self_hosted') {
      throw new HTTPException(400, { message: 'Retry setup is only for self-hosted (BYOS) servers' });
    }

    if (!server.ipv4 || !server.sshPublicKey) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notReadyForDeploy') });
    }

    if (server.setupStatus === 'completed') {
      throw new HTTPException(400, { message: 'Server setup is already completed' });
    }

    let rootPassword = credentials?.rootPassword?.trim() || undefined;
    const userPrivateKey = credentials?.sshPrivateKey?.trim() || undefined;

    if (!rootPassword && !userPrivateKey && server.rootPassword) {
      rootPassword = decrypt(server.rootPassword);
    }

    if (!rootPassword && !userPrivateKey) {
      throw new HTTPException(400, {
        message: 'Provide root password or SSH private key to retry setup',
      });
    }

    if (credentials?.rootPassword) {
      await db
        .update(servers)
        .set({ rootPassword: encrypt(credentials.rootPassword), updatedAt: new Date() })
        .where(eq(servers.id, serverId));
    }

    await db
      .update(servers)
      .set({ setupStatus: 'pending', statusMessage: 'Retrying connection...', updatedAt: new Date() })
      .where(eq(servers.id, serverId));

    void this.setupBYOSServer(serverId, {
      ipv4: server.ipv4,
      pushifyPublicKey: server.sshPublicKey,
      userPrivateKey,
      rootPassword,
    });

    const refreshed = await db.query.servers.findFirst({ where: eq(servers.id, serverId) });
    return toServerDetails(refreshed!, organizationId, {
      statusMessage: 'Retrying server setup...',
    });
  },

  async updateServer(
    serverId: string,
    organizationId: string,
    userId: string,
    input: { name?: string; description?: string | null; autoSnapshotEnabled?: boolean },
    locale: SupportedLocale = 'en',
  ): Promise<ServerWithDetails> {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }
    if (!['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    const updates: Partial<typeof servers.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) {
      const trimmed = input.name.trim();
      if (!trimmed) {
        throw new HTTPException(400, { message: t(locale, 'servers', 'nameRequired') });
      }
      updates.name = trimmed;
    }
    if (input.description !== undefined) {
      updates.description = input.description?.trim() || null;
    }
    if (input.autoSnapshotEnabled !== undefined) {
      const { serverSnapshotAutomationService } = await import(
        './server-snapshot-automation.service'
      );
      const limit = await serverSnapshotAutomationService.getOrgSnapshotLimit(organizationId);
      if (input.autoSnapshotEnabled && limit <= 0) {
        throw new HTTPException(400, {
          message: t(locale, 'servers', 'autoSnapshotPlanRequired'),
        });
      }
      if (!server.isManaged || server.provider !== 'hetzner') {
        throw new HTTPException(400, { message: t(locale, 'servers', 'snapshotsNotSupported') });
      }
      updates.autoSnapshotEnabled = input.autoSnapshotEnabled;
    }

    const [updated] = await db
      .update(servers)
      .set(updates)
      .where(eq(servers.id, serverId))
      .returning();

    return toServerDetails(updated, organizationId);
  },

  async getResizeOptions(
    serverId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en',
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    if (!server.isManaged || server.provider !== 'hetzner') {
      throw new HTTPException(400, { message: t(locale, 'servers', 'resizeNotSupported') });
    }

    const org = await organizationRepository.findById(organizationId);
    const plan = (org?.plan || 'free') as PlanType;
    const options = await infraBillingService.getSizedOptionsForOrganization(
      organizationId,
      plan,
      server.provider as ProviderType,
      server.region,
      locale,
    );

    const currentScore = specsScore(server.vcpus, server.memoryMb);
    return options.filter((opt) => {
      if (!opt.allowedByPlan) return false;
      const optScore = specsScore(opt.specs.vcpus, opt.specs.memoryMb);
      if (optScore <= currentScore && !isUpgradeSize(server.size as ServerSize, opt.size)) {
        return false;
      }
      return optScore > currentScore || isUpgradeSize(server.size as ServerSize, opt.size);
    });
  },

  async resizeServer(
    serverId: string,
    organizationId: string,
    userId: string,
    size: ServerSize,
    locale: SupportedLocale = 'en',
  ): Promise<ServerWithDetails> {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }
    if (!['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    await assertOrganizationCanMutateResources(organizationId, locale);

    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    if (!server.isManaged || server.provider !== 'hetzner' || !server.providerId) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'resizeNotSupported') });
    }

    if (server.status === 'deleting' || server.status === 'provisioning') {
      throw new HTTPException(400, { message: t(locale, 'servers', 'resizeInvalidState') });
    }

    const org = await organizationRepository.findById(organizationId);
    const plan = (org?.plan || 'free') as PlanType;

    const options = await this.getResizeOptions(serverId, organizationId, userId, locale);
    const target = options.find((o) => o.size === size);
    if (!target) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'resizeInvalidSize') });
    }

    const quote = await infraBillingService.quoteManagedServer(
      plan,
      'hetzner',
      server.region,
      size,
      locale,
    );

    const newMonthly = quote.customerPriceMonthlyCents;
    const oldMonthly = server.customerPriceMonthlyCents ?? 0;
    if (newMonthly > oldMonthly) {
      await infraBillingService.assertWalletCanProvision(organizationId, plan, quote, locale);
    }

    const apiToken = getProviderToken('hetzner');
    const provider = createProvider('hetzner', apiToken);

    await db
      .update(servers)
      .set({ status: 'rebooting', statusMessage: 'resizing', updatedAt: new Date() })
      .where(eq(servers.id, serverId));

    try {
      const providerServer = await provider.resize(server.providerId, size);
      const pd = providerServer.providerData as { serverType?: { name?: string } };
      const billingFields = infraBillingService.billingFieldsFromQuote(
        quote,
        pd.serverType?.name,
      );

      const [updated] = await db
        .update(servers)
        .set({
          size,
          vcpus: providerServer.vcpus,
          memoryMb: providerServer.memoryMb,
          diskGb: providerServer.diskGb,
          providerData: providerServer.providerData,
          status: providerServer.status,
          statusMessage: null,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
          ...billingFields,
        })
        .where(eq(servers.id, serverId))
        .returning();

      wsManager.publish(`server:${serverId}`, {
        type: 'server:status',
        data: { serverId, status: updated.status, setupStatus: updated.setupStatus },
      }).catch(() => {});

      return toServerDetails(updated, organizationId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Resize failed';
      await db
        .update(servers)
        .set({
          status: server.status,
          statusMessage: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(servers.id, serverId));

      throw new HTTPException(500, {
        message: t(locale, 'servers', 'resizeFailed'),
      });
    }
  },

  async listServerSnapshots(
    serverId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en',
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    if (!server.isManaged || !server.providerId || server.provider !== 'hetzner') {
      return [];
    }

    const apiToken = getProviderToken('hetzner');
    const provider = createProvider('hetzner', apiToken);
    return provider.listSnapshots(server.providerId);
  },

  async createServerSnapshot(
    serverId: string,
    organizationId: string,
    userId: string,
    input: { name?: string; description?: string },
    locale: SupportedLocale = 'en',
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }
    if (!['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    if (!server.isManaged || !server.providerId || server.provider !== 'hetzner') {
      throw new HTTPException(400, { message: t(locale, 'servers', 'snapshotsNotSupported') });
    }

    if (server.status !== 'running') {
      throw new HTTPException(400, { message: t(locale, 'servers', 'snapshotRequiresRunning') });
    }

    const apiToken = getProviderToken('hetzner');
    const provider = createProvider('hetzner', apiToken);
    const label = input.name?.trim() || `pushify-${server.name}-${Date.now()}`;
    const snapshot = await provider.createSnapshot(server.providerId, label, input.description);

    const { serverSnapshotAutomationService } = await import('./server-snapshot-automation.service');
    const [org] = await db
      .select({
        plan: organizations.plan,
        grandfatheredUntil: organizations.grandfatheredUntil,
        planLimitsOverride: organizations.planLimitsOverride,
      })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1);
    if (org) {
      const limits = getEffectivePlanLimits({
        plan: (org.plan || 'free') as PlanType,
        grandfatheredUntil: org.grandfatheredUntil,
        planLimitsOverride: org.planLimitsOverride as Record<string, number | boolean> | null,
      });
      const all = await provider.listSnapshots(server.providerId);
      await serverSnapshotAutomationService.pruneSnapshots(
        provider,
        all,
        limits.snapshotsPerServer,
      );
    }

    return snapshot;
  },

  async deleteServerSnapshot(
    serverId: string,
    organizationId: string,
    userId: string,
    snapshotId: string,
    locale: SupportedLocale = 'en',
  ): Promise<void> {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }
    if (!['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    if (!server.isManaged || server.provider !== 'hetzner') {
      throw new HTTPException(400, { message: t(locale, 'servers', 'snapshotsNotSupported') });
    }

    const apiToken = getProviderToken('hetzner');
    const provider = createProvider('hetzner', apiToken);
    await provider.deleteSnapshot(snapshotId);
  },

  async restoreServerSnapshot(
    serverId: string,
    organizationId: string,
    userId: string,
    snapshotId: string,
    locale: SupportedLocale = 'en',
  ): Promise<ServerWithDetails> {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }
    if (!['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'adminRequired') });
    }

    await assertOrganizationCanMutateResources(organizationId, locale);

    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    if (!server.isManaged || !server.providerId || server.provider !== 'hetzner') {
      throw new HTTPException(400, { message: t(locale, 'servers', 'snapshotsNotSupported') });
    }

    if (server.status === 'provisioning' || server.status === 'deleting') {
      throw new HTTPException(400, { message: t(locale, 'servers', 'snapshotRestoreInvalidState') });
    }

    const apiToken = getProviderToken('hetzner');
    const provider = createProvider('hetzner', apiToken);
    await provider.restoreSnapshot(server.providerId, snapshotId);

    logger.info({ serverId, snapshotId, userId }, 'Server snapshot restore started');

    return this.syncServer(serverId, organizationId, userId, locale);
  },

  async getServerTimeline(
    serverId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en',
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const [server] = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!server) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    const serverProjects = await db
      .select({ id: projects.id, name: projects.name, slug: projects.slug })
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, organizationId),
          eq(projects.serverId, serverId),
          ne(projects.status, 'deleted'),
        ),
      );

    const projectIds = serverProjects.map((p) => p.id);
    let recentDeployments: Array<{
      id: string;
      status: string;
      trigger: string;
      createdAt: Date;
      projectId: string;
      projectName: string;
      projectSlug: string;
    }> = [];

    if (projectIds.length > 0) {
      const rows = await db
        .select({
          id: deployments.id,
          status: deployments.status,
          trigger: deployments.trigger,
          createdAt: deployments.createdAt,
          projectId: deployments.projectId,
          projectName: projects.name,
          projectSlug: projects.slug,
        })
        .from(deployments)
        .innerJoin(projects, eq(deployments.projectId, projects.id))
        .where(inArray(deployments.projectId, projectIds))
        .orderBy(desc(deployments.createdAt))
        .limit(15);

      recentDeployments = rows;
    }

    const lifecycle: Array<{ type: string; at: Date; detail?: string }> = [
      { type: 'created', at: server.createdAt },
    ];

    if (server.lastSeenAt) {
      lifecycle.push({ type: 'synced', at: server.lastSeenAt });
    }

    if (server.statusMessage === 'resizing') {
      lifecycle.push({ type: 'resizing', at: server.updatedAt });
    }

    if (server.status === 'stopped' && server.statusMessage === 'infra_credits_stopped') {
      lifecycle.push({ type: 'infra_stopped', at: server.updatedAt, detail: server.statusMessage });
    }

    return {
      lifecycle,
      deployments: recentDeployments,
      projects: serverProjects,
    };
  },

};
