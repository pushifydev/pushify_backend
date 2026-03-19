import type { SSHClient } from '../utils/ssh';
import type { NginxSettings } from '../db/schema/projects';
import { env } from '../config/env';

export interface SiteConfig {
  domain: string;
  containerPort: number;
  projectSlug: string;
  ssl?: boolean;
  additionalDomains?: string[];
  nginxSettings?: NginxSettings;
}

const NGINX_SITES_DIR = '/etc/nginx/sites-available';
const NGINX_ENABLED_DIR = '/etc/nginx/sites-enabled';
const PUSHIFY_SITES_DIR = '/opt/pushify/nginx';

// Default nginx settings
const DEFAULT_NGINX_SETTINGS: Required<Omit<NginxSettings, 'proxyPort' | 'customLocationBlocks' | 'customHeaders' | 'rateLimit' | 'caching'>> & Partial<NginxSettings> = {
  proxyTimeout: 86400,
  clientMaxBodySize: '100m',
  enableWebsocket: true,
  enableGzip: true,
  forceHttps: true,
};

/**
 * Generate custom headers block
 */
function generateCustomHeaders(customHeaders?: Record<string, string>): string {
  if (!customHeaders || Object.keys(customHeaders).length === 0) return '';

  return Object.entries(customHeaders)
    .map(([key, value]) => `        add_header ${key} "${value}";`)
    .join('\n');
}

/**
 * Generate rate limiting configuration
 */
function generateRateLimitZone(projectSlug: string, rateLimit?: NginxSettings['rateLimit']): string {
  if (!rateLimit?.enabled) return '';

  return `limit_req_zone $binary_remote_addr zone=pushify_${projectSlug}:10m rate=${rateLimit.requestsPerSecond}r/s;`;
}

/**
 * Generate rate limiting location block
 */
function generateRateLimitLocation(projectSlug: string, rateLimit?: NginxSettings['rateLimit']): string {
  if (!rateLimit?.enabled) return '';

  return `        limit_req zone=pushify_${projectSlug} burst=${rateLimit.burst} nodelay;`;
}

/**
 * Generate Nginx server block configuration for a site
 */
function generateSiteConfig(config: SiteConfig): string {
  const {
    domain,
    containerPort,
    projectSlug,
    ssl = false,
    additionalDomains = [],
    nginxSettings = {}
  } = config;

  // Merge with defaults
  const settings = { ...DEFAULT_NGINX_SETTINGS, ...nginxSettings };
  const {
    proxyPort,
    proxyTimeout,
    clientMaxBodySize,
    enableWebsocket,
    enableGzip,
    customHeaders,
    rateLimit,
    caching,
    customLocationBlocks,
    forceHttps,
  } = settings;

  // Use proxyPort from settings if provided, otherwise use containerPort
  const targetPort = proxyPort || containerPort;

  const allDomains = [domain, ...additionalDomains].join(' ');

  // Generate websocket headers
  const websocketHeaders = enableWebsocket ? `
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;` : '';

  // Generate gzip configuration
  const gzipConfig = enableGzip ? `
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;` : '';

  // Generate custom headers
  const customHeadersBlock = generateCustomHeaders(customHeaders);

  // Generate rate limit zone (goes outside server block)
  const rateLimitZone = generateRateLimitZone(projectSlug, rateLimit);

  // Generate rate limit location directive
  const rateLimitLocation = generateRateLimitLocation(projectSlug, rateLimit);

  // Generate caching configuration
  const cachingConfig = caching?.enabled ? `
        proxy_cache_valid 200 ${caching.maxAge}s;
        add_header X-Cache-Status $upstream_cache_status;` : '';

  // Generate custom location blocks
  const customLocations = customLocationBlocks ? `\n${customLocationBlocks}` : '';

  // Common proxy configuration
  const proxyConfig = `
        proxy_pass http://127.0.0.1:${targetPort};
        proxy_http_version 1.1;${websocketHeaders}
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout ${proxyTimeout};
        proxy_send_timeout ${proxyTimeout};
        proxy_connect_timeout 60;
        proxy_buffering off;${rateLimitLocation ? '\n' + rateLimitLocation : ''}${cachingConfig}${customHeadersBlock ? '\n' + customHeadersBlock : ''}`;

  if (ssl) {
    // HTTPS configuration with SSL
    const httpRedirect = forceHttps ? `
server {
    listen 80;
    listen [::]:80;
    server_name ${allDomains};

    # Redirect HTTP to HTTPS
    return 301 https://$host$request_uri;
}
` : '';

    return `# Pushify site: ${projectSlug}
# Domain: ${domain}
# Proxy port: ${targetPort}${proxyPort ? ` (overridden from ${containerPort})` : ''}
# Generated: ${new Date().toISOString()}
${rateLimitZone ? '\n' + rateLimitZone + '\n' : ''}
${httpRedirect}
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${allDomains};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
    ssl_trusted_certificate /etc/letsencrypt/live/${domain}/chain.pem;

    # SSL configuration
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_session_tickets off;

    # Modern configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # HSTS
    add_header Strict-Transport-Security "max-age=63072000" always;

    # Client settings
    client_max_body_size ${clientMaxBodySize};
${gzipConfig}

    location / {${proxyConfig}
    }${customLocations}
}
`;
  }

  // HTTP-only configuration (before SSL is set up)
  return `# Pushify site: ${projectSlug}
# Domain: ${domain}
# Proxy port: ${targetPort}${proxyPort ? ` (overridden from ${containerPort})` : ''}
# Generated: ${new Date().toISOString()}
${rateLimitZone ? '\n' + rateLimitZone + '\n' : ''}
server {
    listen 80;
    listen [::]:80;
    server_name ${allDomains};

    # Client settings
    client_max_body_size ${clientMaxBodySize};
${gzipConfig}

    location / {${proxyConfig}
    }${customLocations}
}
`;
}

/**
 * Add a new site to Nginx
 */
export async function addSite(
  ssh: SSHClient,
  config: SiteConfig
): Promise<{ success: boolean; message: string }> {
  const { projectSlug } = config;
  const siteFileName = `pushify-${projectSlug}`;
  const configContent = generateSiteConfig(config);

  // Ensure pushify nginx directory exists
  await ssh.exec(`mkdir -p ${PUSHIFY_SITES_DIR}`);

  // Write configuration file
  const configPath = `${NGINX_SITES_DIR}/${siteFileName}`;
  await ssh.uploadFile(configContent, configPath);

  // Create symlink in sites-enabled
  await ssh.exec(`ln -sf ${configPath} ${NGINX_ENABLED_DIR}/${siteFileName}`);

  // Also save a copy to our directory for tracking
  await ssh.uploadFile(configContent, `${PUSHIFY_SITES_DIR}/${siteFileName}.conf`);

  // Test nginx configuration
  const testResult = await ssh.exec('nginx -t 2>&1');
  if (testResult.code !== 0) {
    // Rollback: remove the bad configuration
    await ssh.exec(`rm -f ${NGINX_ENABLED_DIR}/${siteFileName}`);
    await ssh.exec(`rm -f ${configPath}`);

    return {
      success: false,
      message: `Nginx configuration test failed: ${testResult.stderr || testResult.stdout}`,
    };
  }

  return {
    success: true,
    message: `Site ${projectSlug} added to Nginx`,
  };
}

export interface AutoSubdomainSiteConfig {
  domain: string;
  containerPort: number;
  projectSlug: string;
  nginxSettings?: NginxSettings;
}

/**
 * Generate Nginx config for an auto-generated subdomain using wildcard SSL cert
 */
function generateAutoSubdomainSiteConfig(config: AutoSubdomainSiteConfig): string {
  const {
    domain,
    containerPort,
    projectSlug,
    nginxSettings = {},
  } = config;

  const previewBaseUrl = env.PREVIEW_BASE_URL || '';

  // Merge with defaults
  const settings = { ...DEFAULT_NGINX_SETTINGS, ...nginxSettings };
  const {
    proxyPort,
    proxyTimeout,
    clientMaxBodySize,
    enableWebsocket,
    enableGzip,
    customHeaders,
    rateLimit,
    caching,
    customLocationBlocks,
  } = settings;

  const targetPort = proxyPort || containerPort;

  const websocketHeaders = enableWebsocket ? `
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;` : '';

  const gzipConfig = enableGzip ? `
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;` : '';

  const customHeadersBlock = generateCustomHeaders(customHeaders);
  const rateLimitZone = generateRateLimitZone(projectSlug, rateLimit);
  const rateLimitLocation = generateRateLimitLocation(projectSlug, rateLimit);
  const cachingConfig = caching?.enabled ? `
        proxy_cache_valid 200 ${caching.maxAge}s;
        add_header X-Cache-Status $upstream_cache_status;` : '';
  const customLocations = customLocationBlocks ? `\n${customLocationBlocks}` : '';

  const proxyConfig = `
        proxy_pass http://127.0.0.1:${targetPort};
        proxy_http_version 1.1;${websocketHeaders}
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout ${proxyTimeout};
        proxy_send_timeout ${proxyTimeout};
        proxy_connect_timeout 60;
        proxy_buffering off;${rateLimitLocation ? '\n' + rateLimitLocation : ''}${cachingConfig}${customHeadersBlock ? '\n' + customHeadersBlock : ''}`;

  // Use wildcard cert from PREVIEW_BASE_URL
  return `# Pushify site: ${projectSlug} (auto subdomain)
# Domain: ${domain}
# Proxy port: ${targetPort}${proxyPort ? ` (overridden from ${containerPort})` : ''}
# Generated: ${new Date().toISOString()}
${rateLimitZone ? '\n' + rateLimitZone + '\n' : ''}
server {
    listen 80;
    listen [::]:80;
    server_name ${domain};

    # Redirect HTTP to HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${previewBaseUrl}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${previewBaseUrl}/privkey.pem;

    # SSL configuration
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_session_tickets off;

    # Modern configuration
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;

    # HSTS
    add_header Strict-Transport-Security "max-age=63072000" always;

    # Client settings
    client_max_body_size ${clientMaxBodySize};
${gzipConfig}

    location / {${proxyConfig}
    }${customLocations}
}
`;
}

/**
 * Add an auto-generated subdomain site to Nginx using wildcard SSL cert
 */
export async function addAutoSubdomainSite(
  ssh: SSHClient,
  config: AutoSubdomainSiteConfig
): Promise<{ success: boolean; message: string }> {
  const { projectSlug } = config;
  const siteFileName = `pushify-${projectSlug}`;
  const configContent = generateAutoSubdomainSiteConfig(config);

  // Ensure pushify nginx directory exists
  await ssh.exec(`mkdir -p ${PUSHIFY_SITES_DIR}`);

  // Write configuration file
  const configPath = `${NGINX_SITES_DIR}/${siteFileName}`;
  await ssh.uploadFile(configContent, configPath);

  // Create symlink in sites-enabled
  await ssh.exec(`ln -sf ${configPath} ${NGINX_ENABLED_DIR}/${siteFileName}`);

  // Also save a copy to our directory for tracking
  await ssh.uploadFile(configContent, `${PUSHIFY_SITES_DIR}/${siteFileName}.conf`);

  // Test nginx configuration
  const testResult = await ssh.exec('nginx -t 2>&1');
  if (testResult.code !== 0) {
    // Rollback: remove the bad configuration
    await ssh.exec(`rm -f ${NGINX_ENABLED_DIR}/${siteFileName}`);
    await ssh.exec(`rm -f ${configPath}`);

    return {
      success: false,
      message: `Nginx configuration test failed: ${testResult.stderr || testResult.stdout}`,
    };
  }

  return {
    success: true,
    message: `Auto subdomain site ${config.domain} added to Nginx with wildcard SSL`,
  };
}

/**
 * Update an existing site configuration
 */
export async function updateSite(
  ssh: SSHClient,
  config: SiteConfig
): Promise<{ success: boolean; message: string }> {
  // Same as addSite - it will overwrite the existing configuration
  return addSite(ssh, config);
}

/**
 * Remove a site from Nginx
 */
export async function removeSite(
  ssh: SSHClient,
  projectSlug: string
): Promise<{ success: boolean; message: string }> {
  const siteFileName = `pushify-${projectSlug}`;

  // Remove symlink and config file
  await ssh.exec(`rm -f ${NGINX_ENABLED_DIR}/${siteFileName}`);
  await ssh.exec(`rm -f ${NGINX_SITES_DIR}/${siteFileName}`);
  await ssh.exec(`rm -f ${PUSHIFY_SITES_DIR}/${siteFileName}.conf`);

  return {
    success: true,
    message: `Site ${projectSlug} removed from Nginx`,
  };
}

/**
 * Reload Nginx configuration
 */
export async function reloadNginx(
  ssh: SSHClient
): Promise<{ success: boolean; message: string }> {
  // Test configuration first
  const testResult = await ssh.exec('nginx -t 2>&1');
  if (testResult.code !== 0) {
    return {
      success: false,
      message: `Nginx configuration test failed: ${testResult.stderr || testResult.stdout}`,
    };
  }

  // Reload nginx
  const reloadResult = await ssh.exec('systemctl reload nginx');
  if (reloadResult.code !== 0) {
    return {
      success: false,
      message: `Failed to reload Nginx: ${reloadResult.stderr}`,
    };
  }

  return {
    success: true,
    message: 'Nginx reloaded successfully',
  };
}

/**
 * Restart Nginx service
 */
export async function restartNginx(
  ssh: SSHClient
): Promise<{ success: boolean; message: string }> {
  const result = await ssh.exec('systemctl restart nginx');

  return {
    success: result.code === 0,
    message: result.code === 0
      ? 'Nginx restarted successfully'
      : `Failed to restart Nginx: ${result.stderr}`,
  };
}

/**
 * Check Nginx status
 */
export async function checkNginxStatus(
  ssh: SSHClient
): Promise<{ running: boolean; version?: string; error?: string }> {
  const statusResult = await ssh.exec('systemctl is-active nginx');
  const isRunning = statusResult.stdout.trim() === 'active';

  if (!isRunning) {
    return {
      running: false,
      error: 'Nginx is not running',
    };
  }

  const versionResult = await ssh.exec('nginx -v 2>&1');
  const versionMatch = versionResult.stderr?.match(/nginx\/([0-9.]+)/) ||
    versionResult.stdout?.match(/nginx\/([0-9.]+)/);

  return {
    running: true,
    version: versionMatch ? versionMatch[1] : undefined,
  };
}

/**
 * Get list of Pushify-managed sites
 */
export async function listSites(
  ssh: SSHClient
): Promise<string[]> {
  const result = await ssh.exec(`ls ${NGINX_ENABLED_DIR}/pushify-* 2>/dev/null || true`);

  if (!result.stdout.trim()) {
    return [];
  }

  return result.stdout.trim().split('\n').map((path) => {
    // Extract project slug from filename like "/etc/nginx/sites-enabled/pushify-my-project"
    const match = path.match(/pushify-(.+)$/);
    return match ? match[1] : path;
  });
}

/**
 * Get configuration for a specific site
 */
export async function getSiteConfig(
  ssh: SSHClient,
  projectSlug: string
): Promise<string | null> {
  const siteFileName = `pushify-${projectSlug}`;
  const configPath = `${NGINX_SITES_DIR}/${siteFileName}`;

  const result = await ssh.exec(`cat ${configPath} 2>/dev/null || true`);

  return result.stdout.trim() || null;
}

/**
 * Check if a domain is already configured
 */
export async function isDomainConfigured(
  ssh: SSHClient,
  domain: string
): Promise<boolean> {
  // Search for the domain in all nginx configs
  const result = await ssh.exec(`grep -l "server_name.*${domain}" ${NGINX_SITES_DIR}/* 2>/dev/null || true`);

  return result.stdout.trim().length > 0;
}

/**
 * Request SSL certificate using Certbot
 * Uses certonly mode to avoid Certbot modifying Nginx config
 * We manage Nginx config ourselves
 */
export async function requestSSLCertificate(
  ssh: SSHClient,
  domain: string,
  email: string
): Promise<{ success: boolean; message: string }> {
  // Use certonly with webroot or standalone to get certificate without modifying nginx
  // First try webroot (requires existing nginx config serving /.well-known/acme-challenge)
  // Fall back to standalone if webroot fails (temporarily stops nginx)

  // Try certonly with nginx plugin (doesn't modify config, just uses it for auth)
  const result = await ssh.exec(
    `certbot certonly --nginx -d ${domain} --non-interactive --agree-tos -m ${email} 2>&1`
  );

  if (result.code !== 0) {
    // Try standalone as fallback (will temporarily bind to port 80)
    const standaloneResult = await ssh.exec(
      `certbot certonly --standalone -d ${domain} --non-interactive --agree-tos -m ${email} --preferred-challenges http 2>&1`
    );

    if (standaloneResult.code !== 0) {
      return {
        success: false,
        message: `Failed to obtain SSL certificate: ${standaloneResult.stdout || standaloneResult.stderr}`,
      };
    }
  }

  return {
    success: true,
    message: `SSL certificate obtained for ${domain}`,
  };
}

/**
 * Check SSL certificate status for a domain
 */
export async function checkSSLStatus(
  ssh: SSHClient,
  domain: string
): Promise<{ valid: boolean; expiresAt?: Date; error?: string }> {
  const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;

  // Check if certificate exists
  const existsResult = await ssh.exec(`test -f ${certPath} && echo "exists"`);
  if (existsResult.stdout.trim() !== 'exists') {
    return {
      valid: false,
      error: 'Certificate not found',
    };
  }

  // Get certificate expiration date
  const expiryResult = await ssh.exec(
    `openssl x509 -enddate -noout -in ${certPath} 2>/dev/null`
  );

  if (expiryResult.code !== 0) {
    return {
      valid: false,
      error: 'Could not read certificate',
    };
  }

  // Parse expiration date from output like "notAfter=Jan 15 12:00:00 2024 GMT"
  const match = expiryResult.stdout.match(/notAfter=(.+)/);
  if (match) {
    const expiresAt = new Date(match[1]);
    const now = new Date();

    return {
      valid: expiresAt > now,
      expiresAt,
    };
  }

  return {
    valid: false,
    error: 'Could not parse certificate expiration',
  };
}

/**
 * Renew all SSL certificates
 */
export async function renewSSLCertificates(
  ssh: SSHClient
): Promise<{ success: boolean; message: string }> {
  const result = await ssh.exec('certbot renew --quiet 2>&1');

  return {
    success: result.code === 0,
    message: result.code === 0
      ? 'Certificates renewed successfully'
      : `Certificate renewal failed: ${result.stdout || result.stderr}`,
  };
}
