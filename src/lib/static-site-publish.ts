import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema/projects';
import { projectSiteEditor } from '../db/schema/site-editor';
import { SSHClient } from '../utils/ssh';
import { decrypt } from './encryption';
import { renderSiteFiles } from './site-html-renderer';
import type { SitePage } from '../sites/block-types';
import { addStaticSite, requestSSLCertificate } from '../workers/nginx-manager';
import { getOrAssignPort } from '../workers/port-manager';
import { openFirewallPort } from '../workers/remote-deployment';
import { logger } from './logger';

export interface StaticPublishResult {
  ok: boolean;
  ssl: boolean;
  url: string | null;
  port?: number;
  message: string;
}

/**
 * Render a Site Studio project's current block design to HTML, upload it to its server, and
 * configure how it's served:
 *   - with a domain → Nginx vhost on 80/443 (best-effort SSL via certbot);
 *   - without a domain → Nginx vhost on an assigned port (http://<ip>:<port>), firewall opened.
 *
 * Shared by the deployment worker (so static publishes show up as deployments with logs) and
 * the Site Studio launch flow.
 */
export async function publishStaticSite(opts: {
  projectId: string;
  slug: string;
  domain: string | null;
  server: { ipv4: string | null; sshPrivateKey: string | null };
  onLog?: (message: string) => void;
}): Promise<StaticPublishResult> {
  const { projectId, slug, domain, server } = opts;
  const log = opts.onLog ?? (() => {});

  if (!server.ipv4 || !server.sshPrivateKey) {
    return { ok: false, ssl: false, url: null, message: 'Server not reachable' };
  }

  const [row] = await db
    .select()
    .from(projectSiteEditor)
    .where(eq(projectSiteEditor.projectId, projectId))
    .limit(1);
  if (!row) {
    return { ok: false, ssl: false, url: null, message: 'Site editor not initialized' };
  }

  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  const pages: SitePage[] =
    Array.isArray(row.pages) && row.pages.length > 0
      ? row.pages
      : [{ id: 'home', title: 'Home', slug: '', blocks: row.blocks, seo: row.seo }];
  const files = renderSiteFiles(pages, project?.name ?? 'Site', row.theme);

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
    // Replace any previously published pages, then write the current set.
    await ssh.exec(`rm -rf ${dir} && mkdir -p ${dir}`);
    for (const file of files) {
      const target = `${dir}/${file.path}`;
      const subdir = target.slice(0, target.lastIndexOf('/'));
      if (subdir && subdir !== dir) await ssh.exec(`mkdir -p ${subdir}`);
      await ssh.uploadFile(file.html, target);
    }
    log(`📝 Uploaded ${files.length} page(s)`);

    let nginx: { success: boolean; message: string };
    let ssl = false;
    let url: string | null = null;
    let port: number | undefined;

    if (domain) {
      log(`🌐 Configuring Nginx for ${domain}...`);
      nginx = await addStaticSite(ssh, { slug, domain, ssl: false });
      url = `http://${domain}`;
      if (nginx.success) {
        try {
          log('🔐 Requesting SSL certificate...');
          const cert = await requestSSLCertificate(ssh, domain, `admin@${domain}`);
          if (cert.success) {
            const sslRes = await addStaticSite(ssh, { slug, domain, ssl: true });
            if (sslRes.success) {
              ssl = true;
              nginx = sslRes;
              url = `https://${domain}`;
              log('✅ SSL enabled');
            }
          } else {
            log('⚠️ SSL not issued yet (check DNS) — serving over HTTP');
          }
        } catch (err: any) {
          logger.warn({ projectId, domain, err: err?.message }, 'Static SSL provisioning failed');
          log('⚠️ SSL provisioning failed — serving over HTTP');
        }
      }
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

    await db
      .update(projectSiteEditor)
      .set({ publishedHtml: files[0]?.html ?? '', publishedAt: new Date(), updatedAt: new Date() })
      .where(eq(projectSiteEditor.projectId, projectId));

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
