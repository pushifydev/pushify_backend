import { HTTPException } from 'hono/http-exception';
import { eq, and, desc, count } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { organizationRepository } from '../repositories/organization.repository';
import { createProvider, type ProviderType, type ServerConfig } from '../providers';
import { t, type SupportedLocale } from '../i18n';
import { getServerStatusQueue } from '../queue';
import { generateSSHKeyPair } from '../utils/ssh';
import { encrypt, decrypt } from '../lib/encryption';
import { getPlanInfo, isUnlimited, type PlanType } from '../lib/plans';
import { SSHClient } from '../utils/ssh';
import { wsManager } from '../lib/ws';
import { logger } from '../lib/logger';

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
  isManaged: boolean;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date | null;
}

// Get provider API token from organization settings or env
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

    return result.map((s) => ({
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
      isManaged: s.isManaged,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastSeenAt: s.lastSeenAt,
    }));
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

    const result = await db
      .select()
      .from(servers)
      .where(and(eq(servers.id, serverId), eq(servers.organizationId, organizationId)))
      .limit(1);

    if (!result[0]) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    const s = result[0];
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
      isManaged: s.isManaged,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      lastSeenAt: s.lastSeenAt,
    };
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

    // Check server quota
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'notFound') });
    }

    const plan = (org.plan || 'free') as PlanType;
    const planInfo = getPlanInfo(plan);
    const serverLimit = planInfo.limits.servers;

    if (!isUnlimited(serverLimit)) {
      // Count current servers
      const serversResult = await db
        .select({ count: count() })
        .from(servers)
        .where(eq(servers.organizationId, organizationId));
      const currentServerCount = serversResult[0]?.count || 0;

      if (currentServerCount >= serverLimit) {
        throw new HTTPException(403, {
          message: t(locale, 'servers', 'quotaExceeded'),
        });
      }
    }

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
      this.setupBYOSServer(dbServer.id, input.ipv4, input.sshPrivateKey || sshKeyPair.privateKey, sshKeyPair.publicKey, input.rootPassword).catch((err) => {
        logger.error({ err, serverId: dbServer.id }, 'BYOS server setup failed');
      });

      return {
        id: dbServer.id,
        name: dbServer.name,
        description: dbServer.description,
        provider: dbServer.provider,
        providerId: dbServer.providerId,
        region: dbServer.region,
        size: dbServer.size,
        image: dbServer.image,
        vcpus: dbServer.vcpus,
        memoryMb: dbServer.memoryMb,
        diskGb: dbServer.diskGb,
        ipv4: dbServer.ipv4,
        ipv6: dbServer.ipv6,
        privateIp: dbServer.privateIp,
        status: dbServer.status,
        setupStatus: dbServer.setupStatus,
        statusMessage: 'Connecting to server...',
        labels: dbServer.labels as Record<string, unknown>,
        isManaged: dbServer.isManaged,
        createdAt: dbServer.createdAt,
        updatedAt: dbServer.updatedAt,
        lastSeenAt: dbServer.lastSeenAt,
      };
    }

    // ── Managed provider flow ──
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

      return {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        provider: updated.provider,
        providerId: updated.providerId,
        region: updated.region,
        size: updated.size,
        image: updated.image,
        vcpus: updated.vcpus,
        memoryMb: updated.memoryMb,
        diskGb: updated.diskGb,
        ipv4: updated.ipv4,
        ipv6: updated.ipv6,
        privateIp: updated.privateIp,
        status: updated.status,
        setupStatus: updated.setupStatus,
        statusMessage: updated.statusMessage,
        labels: updated.labels as Record<string, unknown>,
        isManaged: updated.isManaged,
        createdAt: updated.createdAt,
        updatedAt: updated.updatedAt,
        lastSeenAt: updated.lastSeenAt,
      };
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

    // Execute action
    switch (action) {
      case 'start':
        await provider.powerOn(server.providerId);
        break;
      case 'stop':
        await provider.powerOff(server.providerId);
        break;
      case 'reboot':
        await provider.reboot(server.providerId);
        break;
    }

    // Update status
    const newStatus = action === 'reboot' ? 'rebooting' : action === 'start' ? 'running' : 'stopped';
    const [updated] = await db
      .update(servers)
      .set({ status: newStatus, updatedAt: new Date() })
      .where(eq(servers.id, serverId))
      .returning();

    return {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      provider: updated.provider,
      providerId: updated.providerId,
      region: updated.region,
      size: updated.size,
      image: updated.image,
      vcpus: updated.vcpus,
      memoryMb: updated.memoryMb,
      diskGb: updated.diskGb,
      ipv4: updated.ipv4,
      ipv6: updated.ipv6,
      privateIp: updated.privateIp,
      status: updated.status,
      setupStatus: updated.setupStatus,
      statusMessage: updated.statusMessage,
      labels: updated.labels as Record<string, unknown>,
      isManaged: updated.isManaged,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      lastSeenAt: updated.lastSeenAt,
    };
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
        providerData: providerServer.providerData,
        lastSeenAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(servers.id, serverId))
      .returning();

    return {
      id: updated.id,
      name: updated.name,
      description: updated.description,
      provider: updated.provider,
      providerId: updated.providerId,
      region: updated.region,
      size: updated.size,
      image: updated.image,
      vcpus: updated.vcpus,
      memoryMb: updated.memoryMb,
      diskGb: updated.diskGb,
      ipv4: updated.ipv4,
      ipv6: updated.ipv6,
      privateIp: updated.privateIp,
      status: updated.status,
      setupStatus: updated.setupStatus,
      statusMessage: updated.statusMessage,
      labels: updated.labels as Record<string, unknown>,
      isManaged: updated.isManaged,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      lastSeenAt: updated.lastSeenAt,
    };
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
  async setupBYOSServer(serverId: string, ipv4: string, privateKey: string, publicKey: string, rootPassword?: string): Promise<void> {
    let ssh: SSHClient | null = null;

    try {
      await db.update(servers).set({ setupStatus: 'installing', statusMessage: 'Connecting to server...' }).where(eq(servers.id, serverId));

      ssh = new SSHClient();
      const connectConfig: any = { host: ipv4, port: 22, username: 'root' };
      if (rootPassword && !privateKey.includes('BEGIN')) {
        connectConfig.password = rootPassword;
      } else {
        connectConfig.privateKey = privateKey;
      }
      await ssh.connect(connectConfig);

      await db.update(servers).set({ statusMessage: 'Connected. Installing dependencies...' }).where(eq(servers.id, serverId));

      // Add public key to authorized_keys
      await ssh.exec(`mkdir -p ~/.ssh && echo '${publicKey}' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys`);

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

};
