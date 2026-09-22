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
/** A header name nginx accepts as a bare word. */
export const HEADER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
/** A value that can't leave its double quotes: no quote, backslash or control characters. */
export const HEADER_VALUE_RE = /^[^"\\\x00-\x1f\x7f]{0,1024}$/;

function generateCustomHeaders(customHeaders?: Record<string, string>): string {
  if (!customHeaders || Object.keys(customHeaders).length === 0) return '';

  // Validated again here, not only at the API: a value with a `"` or a newline used to be written
  // verbatim, which let anyone append their own directives to the host's Nginx config.
  return Object.entries(customHeaders)
    .filter(([key, value]) => HEADER_NAME_RE.test(key) && typeof value === 'string' && HEADER_VALUE_RE.test(value))
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

/**
 * 502 fallback: when the upstream is down (nginx-generated 502, e.g. a slept container),
 * proxy the request to the control plane's wake endpoint, which starts the container and
 * serves a "waking up" page. Requires API_BASE_URL; without it no fallback is emitted.
 */
function generateWakeFallback(projectSlug: string): string {
  if (!env.API_BASE_URL) return '';
  let origin: string;
  let host: string;
  try {
    const url = new URL(env.API_BASE_URL);
    origin = url.origin;
    host = url.host;
  } catch {
    return '';
  }
  return `
    error_page 502 = @pushify_wake;
    location @pushify_wake {
        rewrite ^ /api/v1/wake/${projectSlug} break;
        proxy_pass ${origin};
        proxy_set_header Host ${host};
        proxy_ssl_server_name on;
    }`;
}

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
    }${customLocations}${generateWakeFallback(projectSlug)}
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
    }${customLocations}${generateWakeFallback(projectSlug)}
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

// ============ Whole-project sites ============

/** Where HTTP-01 challenges are answered from (certbot --webroot), on every port-80 block. */
export const ACME_WEBROOT = '/var/www/letsencrypt';

export interface ProjectSiteDomain {
  domain: string;
  /** auto: *.<preview base> on the wildcard cert; custom: its own Let's Encrypt certificate */
  kind: 'auto' | 'custom';
  /** custom: a certificate for `domain` is installed at /etc/letsencrypt/live/<domain> */
  ssl: boolean;
  /** The www / apex counterpart(s): redirected to `domain` */
  aliases?: string[];
  /** Aliases the installed certificate also covers — they redirect over HTTPS too */
  sslAliases?: string[];
  nginxSettings?: NginxSettings;
}

export interface ProjectSitesConfig {
  projectSlug: string;
  containerPort: number;
  domains: ProjectSiteDomain[];
}

const ACME_LOCATION = `
    location ^~ /.well-known/acme-challenge/ {
        root ${ACME_WEBROOT};
        default_type text/plain;
        try_files $uri =404;
    }`;

const TLS_SETTINGS = `
    ssl_session_timeout 1d;
    ssl_session_cache shared:SSL:50m;
    ssl_session_tickets off;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;`;

function certLines(dir: string, withChain: boolean): string {
  return `
    ssl_certificate ${dir}/fullchain.pem;
    ssl_certificate_key ${dir}/privkey.pem;${withChain ? `\n    ssl_trusted_certificate ${dir}/chain.pem;` : ''}`;
}

/** The body every block that actually serves the app shares. */
function appLocation(
  projectSlug: string,
  zoneKey: string,
  containerPort: number,
  nginxSettings: NginxSettings | undefined
): { zone: string; body: string; forceHttps: boolean } {
  const settings = { ...DEFAULT_NGINX_SETTINGS, ...(nginxSettings || {}) };
  const targetPort = settings.proxyPort || containerPort;
  const websocketHeaders = settings.enableWebsocket ? `
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_cache_bypass $http_upgrade;` : '';
  const gzipConfig = settings.enableGzip ? `
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml application/json application/javascript application/rss+xml application/atom+xml image/svg+xml;` : '';
  const rateLimitLocation = generateRateLimitLocation(zoneKey, settings.rateLimit);
  const cachingConfig = settings.caching?.enabled ? `
        proxy_cache_valid 200 ${settings.caching.maxAge}s;
        add_header X-Cache-Status $upstream_cache_status;` : '';
  const customHeadersBlock = generateCustomHeaders(settings.customHeaders);
  const customLocations = settings.customLocationBlocks ? `\n${settings.customLocationBlocks}` : '';

  const body = `
    # Proxy port: ${targetPort}${settings.proxyPort ? ` (overridden from ${containerPort})` : ''}
    client_max_body_size ${settings.clientMaxBodySize};
${gzipConfig}

    location / {
        proxy_pass http://127.0.0.1:${targetPort};
        proxy_http_version 1.1;${websocketHeaders}
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout ${settings.proxyTimeout};
        proxy_send_timeout ${settings.proxyTimeout};
        proxy_connect_timeout 60;
        proxy_buffering off;${rateLimitLocation ? '\n' + rateLimitLocation : ''}${cachingConfig}${customHeadersBlock ? '\n' + customHeadersBlock : ''}
    }${customLocations}${generateWakeFallback(projectSlug)}`;

  return {
    zone: generateRateLimitZone(zoneKey, settings.rateLimit),
    body,
    forceHttps: settings.forceHttps !== false,
  };
}

function renderProjectDomain(site: ProjectSiteDomain, projectSlug: string, containerPort: number, index: number) {
  // One rate-limit zone per domain: two domains of one project each with rate limiting on
  // would otherwise declare the same zone twice and fail `nginx -t`.
  const zoneKey = index === 0 ? projectSlug : `${projectSlug}_${index}`;
  const app = appLocation(projectSlug, zoneKey, containerPort, site.nginxSettings);
  const blocks: string[] = [];
  const aliases = site.aliases ?? [];
  const sslAliases = (site.sslAliases ?? []).filter((a) => aliases.includes(a));

  if (site.kind === 'auto') {
    const wildcardCertDir = env.WILDCARD_SSL_PATH || `/etc/letsencrypt/live/${env.PREVIEW_BASE_URL || ''}`;
    blocks.push(`server {
    listen 80;
    listen [::]:80;
    server_name ${site.domain};
    return 301 https://$host$request_uri;
}`);
    blocks.push(`server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${site.domain};
${certLines(wildcardCertDir, false)}
${TLS_SETTINGS}
    add_header Strict-Transport-Security "max-age=63072000" always;
${app.body}
}`);
    return { zone: app.zone, blocks };
  }

  const certDir = `/etc/letsencrypt/live/${site.domain}`;
  if (site.ssl && app.forceHttps) {
    // Every plain-HTTP name goes to the canonical https URL; challenges still answer on 80.
    blocks.push(`server {
    listen 80;
    listen [::]:80;
    server_name ${[site.domain, ...aliases].join(' ')};
${ACME_LOCATION}
    location / {
        return 301 https://${site.domain}$request_uri;
    }
}`);
  } else {
    blocks.push(`server {
    listen 80;
    listen [::]:80;
    server_name ${site.domain};
${ACME_LOCATION}
${app.body}
}`);
    if (aliases.length) {
      blocks.push(`server {
    listen 80;
    listen [::]:80;
    server_name ${aliases.join(' ')};
${ACME_LOCATION}
    location / {
        return 301 http://${site.domain}$request_uri;
    }
}`);
    }
  }

  if (site.ssl) {
    blocks.push(`server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${site.domain};
${certLines(certDir, true)}
${TLS_SETTINGS}
    add_header Strict-Transport-Security "max-age=63072000" always;
${app.body}
}`);
    if (sslAliases.length) {
      blocks.push(`server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${sslAliases.join(' ')};
${certLines(certDir, true)}
${TLS_SETTINGS}
    return 301 https://${site.domain}$request_uri;
}`);
    }
  }

  return { zone: app.zone, blocks };
}

/**
 * The project's whole vhost file: every domain it has, each with its own blocks. Written as
 * one file so no writer (deploy, verify, settings edit) can drop another domain's config —
 * which is what used to happen when each wrote only "its" domain into the shared file.
 */
export function generateProjectSitesConfig(config: ProjectSitesConfig): string {
  const rendered = config.domains.map((site, i) =>
    renderProjectDomain(site, config.projectSlug, config.containerPort, i)
  );
  const zones = rendered.map((r) => r.zone).filter(Boolean);
  const names = config.domains
    .map((d) => [d.domain, ...(d.aliases ?? [])].join(' + '))
    .join(', ');

  return `# Pushify site: ${config.projectSlug}
# Domains: ${names || '(none)'}
# Generated: ${new Date().toISOString()}
${zones.length ? '\n' + zones.join('\n') + '\n' : ''}
${rendered.flatMap((r) => r.blocks).join('\n\n')}
`;
}

/**
 * Write the project's vhost file and test it. On a failed `nginx -t` the previous file is put
 * back (instead of deleting the site, which took every domain of the project offline).
 */
export async function writeProjectSites(
  ssh: SSHClient,
  config: ProjectSitesConfig
): Promise<{ success: boolean; message: string }> {
  const siteFileName = `pushify-${config.projectSlug}`;
  const configPath = `${NGINX_SITES_DIR}/${siteFileName}`;
  const backupPath = `${PUSHIFY_SITES_DIR}/${siteFileName}.prev`;

  await ssh.exec(`mkdir -p ${PUSHIFY_SITES_DIR} ${ACME_WEBROOT}`);

  if (config.domains.length === 0) {
    await removeSite(ssh, config.projectSlug);
    return { success: true, message: `Site ${config.projectSlug} has no domains; vhost removed` };
  }

  const hadPrevious = (await ssh.exec(`test -f ${configPath} && cp -f ${configPath} ${backupPath} && echo yes || true`))
    .stdout.trim() === 'yes';

  const content = generateProjectSitesConfig(config);
  await ssh.uploadFile(content, configPath);
  await ssh.exec(`ln -sf ${configPath} ${NGINX_ENABLED_DIR}/${siteFileName}`);

  const testResult = await ssh.exec('nginx -t 2>&1');
  if (testResult.code !== 0) {
    if (hadPrevious) {
      await ssh.exec(`cp -f ${backupPath} ${configPath}`);
    } else {
      await ssh.exec(`rm -f ${NGINX_ENABLED_DIR}/${siteFileName} ${configPath}`);
    }
    return {
      success: false,
      message: `Nginx configuration test failed: ${testResult.stderr || testResult.stdout}`,
    };
  }

  await ssh.uploadFile(content, `${PUSHIFY_SITES_DIR}/${siteFileName}.conf`);
  return { success: true, message: `Site ${config.projectSlug} written (${config.domains.length} domain(s))` };
}

/** The names an installed certificate covers, or null when there is none. */
export async function readCertificateNames(ssh: SSHClient, domain: string): Promise<string[] | null> {
  const certPath = `/etc/letsencrypt/live/${domain}/fullchain.pem`;
  const result = await ssh.exec(
    `test -f ${certPath} && openssl x509 -in ${certPath} -noout -text 2>/dev/null | grep -o 'DNS:[^,[:space:]]*' || echo __none__`
  );
  const out = result.stdout.trim();
  if (!out || out === '__none__') return null;
  return out
    .split(/\s+/)
    .map((entry) => entry.replace(/^DNS:/, '').toLowerCase())
    .filter(Boolean);
}

export interface StaticSiteConfig {
  /** Project slug — site files live at /opt/pushify/site-studio/<slug>. */
  slug: string;
  /** Domain mode: serve by server_name on 80/443. */
  domain?: string;
  /** Port mode: serve on http://<server-ip>:<port> (no domain needed). */
  port?: number;
  ssl?: boolean;
  additionalDomains?: string[];
}

/** Static-file Nginx vhost: serves /opt/pushify/site-studio/<slug> (no upstream container). */
function generateStaticSiteConfig(config: StaticSiteConfig): string {
  const { domain, port, slug, ssl = false, additionalDomains = [] } = config;
  const root = `/opt/pushify/site-studio/${slug}`;

  const serveBlock = `
    root ${root};
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    gzip on;
    gzip_types text/css application/javascript image/svg+xml application/json;`;

  // Port mode — reachable at http://<server-ip>:<port> without any domain.
  if (port) {
    return `# Pushify static site (port ${port}): ${slug}
server {
    listen ${port};
    listen [::]:${port};
    server_name _;
${serveBlock}
}
`;
  }

  const allDomains = [domain, ...additionalDomains].filter(Boolean).join(' ');

  if (ssl) {
    return `# Pushify static site: ${slug}
server {
    listen 80;
    listen [::]:80;
    server_name ${allDomains};
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name ${allDomains};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;
${serveBlock}
}
`;
  }

  return `# Pushify static site: ${slug}
server {
    listen 80;
    listen [::]:80;
    server_name ${allDomains};

    location /.well-known/acme-challenge/ { root /var/www/html; }
${serveBlock}
}
`;
}

/**
 * Add (or replace) an Nginx vhost that serves a project's published static HTML directly,
 * with no upstream container. Used by 'static' Site Studio sites.
 */
export async function addStaticSite(
  ssh: SSHClient,
  config: StaticSiteConfig,
): Promise<{ success: boolean; message: string }> {
  const confName = `pushify-${config.slug}.conf`;
  const configContent = generateStaticSiteConfig(config);

  // Write to conf.d (included by nginx on every distro) rather than the Debian-only
  // sites-available/sites-enabled layout — BYOS servers may run RHEL-family nginx, where
  // those directories don't exist (the SFTP write would otherwise fail "No such file").
  await ssh.exec(`mkdir -p /etc/nginx/conf.d /opt/pushify/site-studio/${config.slug} ${PUSHIFY_SITES_DIR}`);

  const confPath = `/etc/nginx/conf.d/${confName}`;
  await ssh.uploadFile(configContent, confPath);
  await ssh.uploadFile(configContent, `${PUSHIFY_SITES_DIR}/${confName}`); // tracking copy

  // RHEL/SELinux: let nginx bind to the non-standard port and read the site dir.
  // Best-effort — a no-op when SELinux is disabled or the tools aren't installed.
  if (config.port) {
    await ssh.exec(
      `command -v semanage >/dev/null 2>&1 && ` +
      `(semanage port -a -t http_port_t -p tcp ${config.port} 2>/dev/null || ` +
      `semanage port -m -t http_port_t -p tcp ${config.port} 2>/dev/null) || true`,
    );
  }
  // SELinux: label the site files so nginx is allowed to read them (best-effort).
  await ssh.exec(
    `command -v chcon >/dev/null 2>&1 && ` +
    `chcon -R -t httpd_sys_content_t /opt/pushify/site-studio/${config.slug} 2>/dev/null || true`,
  );

  const testResult = await ssh.exec('nginx -t 2>&1');
  if (testResult.code !== 0) {
    await ssh.exec(`rm -f ${confPath}`);
    return {
      success: false,
      message: `Nginx configuration test failed: ${testResult.stderr || testResult.stdout}`,
    };
  }

  await ssh.exec(RELOAD_AND_SETTLE);
  return { success: true, message: `Static site ${config.slug} added to Nginx` };
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

  // Wildcard cert directory for *.<previewBaseUrl>. Certbot may store it under a
  // different lineage name than the base domain (e.g. the apex `pushify.dev` cert
  // already owns /etc/letsencrypt/live/pushify.dev, so the wildcard lands in
  // .../pushify.dev-0001), so honor WILDCARD_SSL_PATH when set and only fall back to
  // the base-domain path. Mirrors the same resolution in the deploy workers.
  const wildcardCertDir = env.WILDCARD_SSL_PATH || `/etc/letsencrypt/live/${previewBaseUrl}`;

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

    ssl_certificate ${wildcardCertDir}/fullchain.pem;
    ssl_certificate_key ${wildcardCertDir}/privkey.pem;

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
    }${customLocations}${generateWakeFallback(projectSlug)}
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
 * Shared hosts: a TLS catch-all, so a name nginx has no site for gets its connection closed —
 * without one nginx answers with the first TLS site it loaded, i.e. another customer's site and
 * certificate. Self-signed (it is never meant to validate). Skipped when a 443 default_server
 * exists already; removed again if nginx rejects it.
 */
export const CATCH_ALL_TLS_SCRIPT = `
# nginx -T without comments: Debian's stock default site carries "# listen 443 ssl default_server;"
LIVE_CONF=$(nginx -T 2>/dev/null | sed 's/#.*$//')
if ! printf '%s\\n' "$LIVE_CONF" | grep -Eq 'listen[[:space:]][^;]*443[^;]*default_server'; then
  mkdir -p /etc/nginx/pushify-default
  [ -f /etc/nginx/pushify-default/cert.pem ] || openssl req -x509 -nodes -newkey rsa:2048 -days 3650 -subj /CN=invalid \\
    -keyout /etc/nginx/pushify-default/key.pem -out /etc/nginx/pushify-default/cert.pem >/dev/null 2>&1
  V6=''
  printf '%s\\n' "$LIVE_CONF" | grep -Eq 'listen[[:space:]]+\\[::\\]:443' && V6='    listen [::]:443 ssl default_server;'
  printf '%s\\n' '# Pushify: unknown names on 443 get nothing (not another site) — generated' 'server {' \\
    '    listen 443 ssl default_server;' "$V6" '    server_name _;' \\
    '    ssl_certificate /etc/nginx/pushify-default/cert.pem;' '    ssl_certificate_key /etc/nginx/pushify-default/key.pem;' \\
    '    return 444;' '}' > ${NGINX_SITES_DIR}/pushify-00-default
  ln -sf ${NGINX_SITES_DIR}/pushify-00-default ${NGINX_ENABLED_DIR}/pushify-00-default
  if nginx -t >/dev/null 2>&1; then echo PUSHIFY_CATCHALL=added; else rm -f ${NGINX_ENABLED_DIR}/pushify-00-default ${NGINX_SITES_DIR}/pushify-00-default; echo PUSHIFY_CATCHALL=rejected; fi
else
  echo PUSHIFY_CATCHALL=present
fi`;

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

  // Reload nginx — systemd when there is one, otherwise signal the master directly (LXC,
  // containers, OpenRC hosts: `systemctl` alone failed there and took every domain step with it)
  // — and return only once the new config is what answers (see RELOAD_AND_SETTLE).
  const reloadResult = await ssh.exec(RELOAD_AND_SETTLE);
  if (reloadResult.code !== 0) {
    return {
      success: false,
      message: `Failed to reload Nginx: ${reloadResult.stderr || reloadResult.stdout}`,
    };
  }

  return {
    success: true,
    message: 'Nginx reloaded successfully',
  };
}

/**
 * `nginx -s reload` only signals the master: until each old worker handles the signal it keeps
 * accepting new connections with the old config. A deploy that retired the old container right
 * after the reload could send those requests to a container that was gone (502), and "deployed"
 * didn't yet mean "serving". So: note the master's workers before reloading, then wait (≤5s)
 * until each has exited or is "shutting down" — it no longer accepts connections then. Only the
 * host master's children are watched; app containers run nginx workers too.
 */
export const RELOAD_AND_SETTLE = [
  'm=$(cat /run/nginx.pid 2>/dev/null || cat /var/run/nginx.pid 2>/dev/null)',
  'old=$([ -n "$m" ] && pgrep -P "$m" 2>/dev/null | tr "\\n" " ")',
  '(systemctl reload nginx 2>&1 || nginx -s reload 2>&1); rc=$?',
  'if [ $rc -eq 0 ] && [ -n "$old" ]; then',
  '  for _ in $(seq 1 50); do',
  '    busy=0',
  '    for p in $old; do',
  '      t=$(tr "\\0" " " < /proc/$p/cmdline 2>/dev/null)',
  '      case "$t" in ""|*"shutting down"*) ;; *) busy=1 ;; esac',
  '    done',
  '    [ $busy -eq 0 ] && break',
  '    sleep 0.1',
  '  done',
  'fi',
  'exit $rc',
].join('\n');

/**
 * Restart Nginx service
 */
export async function restartNginx(
  ssh: SSHClient
): Promise<{ success: boolean; message: string }> {
  // Without systemd: stop if running (ignore "not running"), then start the binary.
  const result = await ssh.exec('systemctl restart nginx 2>&1 || { nginx -s quit 2>/dev/null; sleep 1; nginx 2>&1; }');

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
 * Request an SSL certificate using Certbot (certonly — we manage the Nginx config ourselves).
 *
 * `aliases` go on the same certificate (e.g. www.example.com next to example.com). The lineage
 * is pinned to `--cert-name <domain>` so it always lives at /etc/letsencrypt/live/<domain>
 * (without it a second request with more names lands in `<domain>-0001` and Nginx keeps
 * serving the old one), and `--expand` lets a later request add a name to it.
 * Order: the nginx plugin, then the webroot our port-80 blocks serve, then standalone (only
 * useful when Nginx is not holding port 80).
 */
export async function requestSSLCertificate(
  ssh: SSHClient,
  domain: string,
  email: string,
  options: { aliases?: string[] } = {}
): Promise<{ success: boolean; message: string }> {
  const names = [domain, ...(options.aliases ?? []).filter((a) => a && a !== domain)];
  const domainArgs = names.map((n) => `-d ${n}`).join(' ');
  const common = `--cert-name ${domain} ${domainArgs} --expand --non-interactive --agree-tos -m ${email}`;

  const attempts = [
    `certbot certonly --nginx ${common} 2>&1`,
    `mkdir -p ${ACME_WEBROOT} && certbot certonly --webroot -w ${ACME_WEBROOT} ${common} 2>&1`,
    `certbot certonly --standalone --preferred-challenges http ${common} 2>&1`,
  ];

  let last = '';
  for (const command of attempts) {
    const result = await ssh.exec(command);
    if (result.code === 0) {
      return { success: true, message: `SSL certificate obtained for ${names.join(', ')}` };
    }
    last = result.stdout || result.stderr;
  }

  return { success: false, message: `Failed to obtain SSL certificate: ${last}` };
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
