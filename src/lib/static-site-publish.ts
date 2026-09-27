import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { projectSiteEditor } from '../db/schema/site-editor';
import { SSHClient } from '../utils/ssh';
import { decrypt } from './encryption';
import { renderSiteFiles } from './site-html-renderer';
import type { SitePage } from '../sites/block-types';
import { addStaticSite } from '../workers/nginx-manager';
import { getOrAssignPort } from '../workers/port-manager';
import { openFirewallPort } from '../workers/remote-deployment';
import { logger } from './logger';
import { env } from '../config/env';
import { shellQuote } from './static-upload';

export interface StaticPublishResult {
  ok: boolean;
  ssl: boolean;
  url: string | null;
  port?: number;
  message: string;
}

/** A Site Studio design rendered to HTML files, or null when the editor was never set up. */
async function renderEditorFiles(projectId: string): Promise<{ path: string; content: string }[] | null> {
  const [row] = await db
    .select()
    .from(projectSiteEditor)
    .where(eq(projectSiteEditor.projectId, projectId))
    .limit(1);
  if (!row) return null;

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  const pages: SitePage[] =
    Array.isArray(row.pages) && row.pages.length > 0
      ? row.pages
      : [{ id: 'home', title: 'Home', slug: '', blocks: row.blocks, seo: row.seo }];
  return renderSiteFiles(pages, project?.name ?? 'Site', row.theme).map((f) => ({ path: f.path, content: f.html }));
}

/**
 * Put a static site on its server and configure how it's served. The files are either the
 * Site Studio design rendered to HTML, or `files` given by the caller (an uploaded site).
 *   - with a custom domain → Nginx vhost on 80/443 (best-effort SSL via certbot);
 *   - on Pushify's shared host (it carries the *.pushify.dev wildcard cert) → an auto subdomain
 *     over HTTPS, no domain needed;
 *   - otherwise → Nginx vhost on an assigned port (http://<ip>:<port>), firewall opened.
 * The new files are written beside the live ones and swapped in, so visitors never hit a
 * half-uploaded site.
 *
 * Shared by the deployment worker (so static publishes show up as deployments with logs) and
 * the Site Studio launch flow.
 */
export async function publishStaticSite(opts: {
  projectId: string;
  slug: string;
  /**
   * Name of the site's folder and Nginx vhost on the server. Defaults to the slug, which is only
   * unique within an organisation — sites on a shared runner pass something globally unique.
   */
  siteKey?: string;
  domain: string | null;
  server: { id?: string; ipv4: string | null; sshPrivateKey: string | null };
  files?: { path: string; content: string | Uint8Array }[];
  onLog?: (message: string) => void;
}): Promise<StaticPublishResult> {
  const { projectId, slug: subdomainSlug, server } = opts;
  const slug = opts.siteKey ?? subdomainSlug;
  let domain = opts.domain;
  const log = opts.onLog ?? (() => {});

  if (!server.ipv4 || !server.sshPrivateKey) {
    return { ok: false, ssl: false, url: null, message: 'Server not reachable' };
  }

  const fromEditor = !opts.files;
  const files = opts.files ?? (await renderEditorFiles(projectId));
  if (!files) {
    return { ok: false, ssl: false, url: null, message: 'Site editor not initialized' };
  }

  const ssh = new SSHClient();
  try {
    log('🔌 Connecting to server...');
    await ssh.connect({
      host: server.ipv4,
      port: 22,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    const dir = `/opt/pushify/site-studio/${slug}`;
    const staging = `${dir}.new`;
    // Write the new version beside the live one, then swap: the site is never half-uploaded.
    await ssh.exec(`rm -rf ${staging} && mkdir -p ${staging}`);
    const subdirs = [...new Set(files.map((f) => f.path.split('/').slice(0, -1).join('/')).filter(Boolean))];
    if (subdirs.length > 0) {
      await ssh.exec(`cd ${staging} && mkdir -p ${subdirs.map(shellQuote).join(' ')}`);
    }
    await ssh.uploadFiles(files.map((f) => ({ remotePath: `${staging}/${f.path}`, content: f.content })));
    await ssh.exec(`rm -rf ${dir}.old; if [ -d ${dir} ]; then mv ${dir} ${dir}.old; fi; mv ${staging} ${dir} && rm -rf ${dir}.old`);
    log(`📝 Uploaded ${files.length} file(s)`);

    // Pushify's shared host carries the *.pushify.dev wildcard cert: a site without a custom
    // domain gets <slug>.pushify.dev there, over HTTPS, instead of http://ip:port.
    const previewBase = env.PREVIEW_BASE_URL;
    const wildcardDir = previewBase ? env.WILDCARD_SSL_PATH || `/etc/letsencrypt/live/${previewBase}` : null;
    const hasWildcard =
      !!wildcardDir &&
      (await ssh.exec(`test -f ${wildcardDir}/fullchain.pem && echo yes || echo no`)).stdout.trim() === 'yes';
    const isAutoDomain = (d: string | null) => !!d && !!previewBase && d.endsWith(`.${previewBase}`);
    if (!domain && hasWildcard) {
      const { domainService } = await import('../services/domain.service');
      const auto = await domainService.createAutoSubdomain(projectId, subdomainSlug, server.id ?? '').catch(() => null);
      if (auto) {
        domain = auto.domain;
        log(`✅ Subdomain: ${domain}`);
      }
    }

    let nginx: { success: boolean; message: string };
    let ssl = false;
    let url: string | null = null;
    let port: number | undefined;

    if (domain && (!isAutoDomain(domain) || hasWildcard)) {
      if (isAutoDomain(domain)) {
        const { cloudflareDnsConfigured, ensureAutoSubdomainRecord } = await import('./cloudflare-dns');
        if (cloudflareDnsConfigured()) {
          await ensureAutoSubdomainRecord(domain, server.ipv4).catch((err) =>
            log(`⚠️ DNS record for ${domain} not updated: ${err instanceof Error ? err.message : 'unknown'}`),
          );
        }
      }
      // Same path as app domains: every domain of the project, www redirects, certificates —
      // serving the site's folder instead of a container (project-sites.ts picks that up).
      log('🌐 Configuring Nginx for the site\'s domains...');
      const { syncProjectSites, describeSyncedDomains } = await import('./project-sites');
      const { isSharedRunnerServer } = await import('./runner-routing');
      const sync = await syncProjectSites(ssh, {
        projectId,
        projectSlug: slug,
        containerPort: 0,
        serverIp: server.ipv4,
        requestCertificates: true,
        sharedHost: isSharedRunnerServer(server.id ?? null),
        onProgress: log,
      });
      nginx = { success: sync.success, message: sync.message };
      const primary = sync.domains.find((d) => d.domain === domain) ?? sync.domains[0];
      ssl = !!primary?.ssl;
      url = primary ? `${ssl ? 'https' : 'http'}://${primary.domain}` : null;
      if (sync.success && sync.domains.length) log(`🌐 ${describeSyncedDomains(sync.domains)}`);
    } else {
      const assigned = await getOrAssignPort(ssh, slug);
      port = assigned.port;
      log(`🔢 Serving on port ${port}`);
      nginx = await addStaticSite(ssh, { slug, port });
      if (nginx.success) {
        await openFirewallPort(ssh, port, log);
      }
      url = `http://${server.ipv4}:${port}`;
    }

    if (fromEditor) {
      const first = files[0]?.content;
      await db
        .update(projectSiteEditor)
        .set({
          publishedHtml: typeof first === 'string' ? first : '',
          publishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projectSiteEditor.projectId, projectId));
    }

    if (nginx.success) {
      log(`✅ Static site published: ${url}`);
    } else {
      log(`❌ Nginx configuration failed: ${nginx.message}`);
    }

    return { ok: nginx.success, ssl, url: nginx.success ? url : null, port, message: nginx.message };
  } catch (err: any) {
    logger.warn({ err: err?.message, projectId }, 'Static site publish failed');
    return { ok: false, ssl: false, url: null, message: err?.message ?? 'publish failed' };
  } finally {
    ssh.disconnect();
  }
}
