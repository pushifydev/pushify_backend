import { HTTPException } from 'hono/http-exception';
import { promises as dns } from 'dns';
import { domainRepository } from '../repositories/domain.repository';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { environmentVariables } from '../db/schema/projects';
import { deployments } from '../db/schema/deployments';
import { eq, and, desc, isNotNull } from 'drizzle-orm';
import { SSHClient } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { syncProjectSites } from '../lib/project-sites';
import { resolveProjectServerId } from '../lib/runner-routing';
import { getOrAssignPort } from '../workers/port-manager';
import { t, type SupportedLocale } from '../i18n';
import { assertMemberProjectScope } from '../lib/member-project-scope';
import { logger } from '../lib/logger';
import { env } from '../config/env';
import { planLimitsService } from './plan-limits.service';

/**
 * Resolve the host port the app is actually published on, so a domain's Nginx vhost
 * proxies to the right place. The deploy uses the project's `PORT` env var as the host
 * port when set (otherwise a dynamically-assigned port) — mirror that here, else a custom
 * domain ends up proxying to a different/assigned port and 502s while the app itself is up.
 */
async function resolveProjectPort(
  ssh: SSHClient,
  projectId: string,
  projectSlug: string,
): Promise<number> {
  // 1) Source of truth: the actual host port the most recent deploy published on. This
  //    covers every deploy path (blue-green, marketplace, rollback) since each records the
  //    real port it used — no re-derivation to drift out of sync.
  try {
    const [latest] = await db
      .select({ containerPort: deployments.containerPort })
      .from(deployments)
      .where(and(eq(deployments.projectId, projectId), isNotNull(deployments.containerPort)))
      .orderBy(desc(deployments.createdAt))
      .limit(1);
    if (latest?.containerPort && latest.containerPort > 0) return latest.containerPort;
  } catch {
    // fall through
  }
  // 2) The project's PORT env (the deploy uses it as the host port when set).
  try {
    const [portEnv] = await db
      .select({ valueEncrypted: environmentVariables.valueEncrypted })
      .from(environmentVariables)
      .where(
        and(
          eq(environmentVariables.projectId, projectId),
          eq(environmentVariables.key, 'PORT'),
        ),
      )
      .limit(1);
    if (portEnv?.valueEncrypted) {
      const p = parseInt(decrypt(portEnv.valueEncrypted), 10);
      if (Number.isFinite(p) && p > 0 && p < 65536) return p;
    }
  } catch {
    // fall through to the assigned port
  }
  // 3) Last resort: the dynamically-assigned port.
  const { port } = await getOrAssignPort(ssh, projectSlug);
  return port;
}

interface CreateDomainInput {
  domain: string;
  isPrimary?: boolean;
}

interface DnsSetupInfo {
  domain: string;
  serverIp: string | null;
  recordType: 'A';
  currentIp: string | null;
  isConfigured: boolean;
  message: string;
}

// Simple domain validation regex
const DOMAIN_REGEX = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

/**
 * Resolve domain's A record to get IP address
 */
async function resolveDomainIp(domain: string): Promise<string | null> {
  try {
    const addresses = await dns.resolve4(domain);
    return addresses[0] || null;
  } catch {
    return null;
  }
}

export const domainService = {
  /**
   * Check if user has access to project
   */
  async checkProjectAccess(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale,
    requireWrite = false
  ) {
    // Verify organization membership
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Writes (create/delete/setPrimary/verify/nginx) require a non-viewer role (M-3).
    if (requireWrite && !['owner', 'admin', 'member'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    // Verify project exists and belongs to organization
    const project = await projectRepository.findById(projectId);
    if (!project || project.organizationId !== organizationId || project.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    await assertMemberProjectScope(membership, organizationId, userId, projectId, locale);

    return project;
  },

  /**
   * Get DNS setup instructions for a domain
   */
  async getDnsSetup(
    domainId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ): Promise<DnsSetupInfo> {
    const project = await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const domain = await domainRepository.findById(domainId);
    if (!domain || domain.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'notFound') });
    }

    // Get server IP — the assigned server, or the shared runner an unassigned project runs on
    let serverIp: string | null = null;
    const targetServerId = resolveProjectServerId(project);
    if (targetServerId) {
      const server = await db.query.servers.findFirst({
        where: eq(servers.id, targetServerId),
      });
      serverIp = server?.ipv4 || null;
    }

    // Check current DNS
    const currentIp = await resolveDomainIp(domain.domain);
    const isConfigured = currentIp === serverIp && serverIp !== null;

    let message: string;
    if (!serverIp) {
      message = t(locale, 'domains', 'noServerAssigned');
    } else if (!currentIp) {
      message = t(locale, 'domains', 'dnsNotConfigured');
    } else if (isConfigured) {
      message = t(locale, 'domains', 'dnsConfigured');
    } else {
      message = t(locale, 'domains', 'dnsPointsElsewhere');
    }

    return {
      domain: domain.domain,
      serverIp,
      recordType: 'A',
      currentIp,
      isConfigured,
      message,
    };
  },

  /**
   * Get all domains for a project
   */
  async getByProject(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);
    return domainRepository.findByProject(projectId);
  },

  /**
   * Get single domain
   */
  async getById(
    domainId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const domain = await domainRepository.findById(domainId);
    if (!domain || domain.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'notFound') });
    }

    return domain;
  },

  /**
   * Create an auto-generated subdomain for a project (e.g. my-app.pushify.dev)
   * Uses wildcard SSL cert — no DNS verification needed.
   */
  async createAutoSubdomain(projectId: string, projectSlug: string, _serverId: string) {
    const previewBaseUrl = env.PREVIEW_BASE_URL;
    if (!previewBaseUrl) {
      logger.info('PREVIEW_BASE_URL not set, skipping auto subdomain creation');
      return null;
    }

    // Check if this auto-generated subdomain already exists for this project
    const existing = await domainRepository.findAutoGeneratedByProject(projectId);
    if (existing) {
      logger.info({ projectId, domain: existing.domain }, 'Auto subdomain already exists');
      return existing;
    }

    // Generate unique subdomain — add short suffix if slug is taken
    let subdomainName = `${projectSlug}.${previewBaseUrl}`;
    const existingDomain = await domainRepository.findByDomain(subdomainName);
    if (existingDomain) {
      const suffix = projectId.slice(0, 6);
      subdomainName = `${projectSlug}-${suffix}.${previewBaseUrl}`;
      // Check again with suffix
      const existingWithSuffix = await domainRepository.findByDomain(subdomainName);
      if (existingWithSuffix) {
        logger.warn({ projectId, domain: subdomainName }, 'Auto subdomain still taken after suffix');
        return null;
      }
    }

    // If the project already has domains, this auto subdomain should not be primary
    const existingDomains = await domainRepository.findByProject(projectId);
    const shouldBePrimary = existingDomains.length === 0;

    // Create with sslStatus 'active' since we use a wildcard cert
    const domain = await domainRepository.create({
      projectId,
      domain: subdomainName,
      isPrimary: shouldBePrimary,
      isAutoGenerated: true,
      sslStatus: 'active',
    });

    // Mark as verified immediately (we control *.pushify.dev)
    await domainRepository.update(domain.id, {
      verifiedAt: new Date(),
    });

    // If this became primary and there were other domains, update primary flags
    if (shouldBePrimary && existingDomains.length > 0) {
      await domainRepository.setPrimary(projectId, domain.id);
    }

    logger.info({ projectId, domain: subdomainName }, 'Auto subdomain created');
    return domain;
  },

  /**
   * Create new domain
   */
  async create(
    projectId: string,
    organizationId: string,
    userId: string,
    input: CreateDomainInput,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale, true);

    // Validate domain format
    const domainName = input.domain.toLowerCase().trim();
    if (!DOMAIN_REGEX.test(domainName)) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
    }

    await planLimitsService.assertCustomDomainsQuota(organizationId, locale);

    // Check if domain already exists globally
    const existingDomain = await domainRepository.findByDomain(domainName);
    if (existingDomain) {
      throw new HTTPException(409, { message: t(locale, 'domains', 'alreadyExists') });
    }

    // If this is the first domain or marked as primary, set it as primary
    const existingDomains = await domainRepository.findByProject(projectId);
    const shouldBePrimary = input.isPrimary || existingDomains.length === 0;

    const domain = await domainRepository.create({
      projectId,
      domain: domainName,
      isPrimary: shouldBePrimary,
      sslStatus: 'pending',
    });

    // If this domain should be primary and there are other domains, unset their primary flags
    if (shouldBePrimary && existingDomains.length > 0) {
      await domainRepository.setPrimary(projectId, domain.id);
    }

    return domain;
  },

  /**
   * Set domain as primary
   */
  async setPrimary(
    domainId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale, true);

    const domain = await domainRepository.findById(domainId);
    if (!domain || domain.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'notFound') });
    }

    return domainRepository.setPrimary(projectId, domainId);
  },

  /**
   * Verify domain DNS configuration and set up Nginx + SSL
   */
  async verify(
    domainId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const project = await this.checkProjectAccess(projectId, organizationId, userId, locale, true);

    const domain = await domainRepository.findById(domainId);
    if (!domain || domain.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'notFound') });
    }

    // The server the app runs on: its own, or the shared runner (free / unassigned projects)
    const targetServerId = resolveProjectServerId(project);
    if (!targetServerId) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'noServerAssigned') });
    }

    const server = await db.query.servers.findFirst({
      where: eq(servers.id, targetServerId),
    });

    if (!server || !server.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'serverNotReady') });
    }

    // Skip DNS verification for auto-generated subdomains (we control *.pushify.dev)
    if (!domain.isAutoGenerated) {
      const currentIp = await resolveDomainIp(domain.domain);
      if (!currentIp) {
        throw new HTTPException(400, {
          message: `DNS not configured. Please add an A record pointing ${domain.domain} to ${server.ipv4}`
        });
      }

      if (currentIp !== server.ipv4) {
        throw new HTTPException(400, {
          message: `DNS points to ${currentIp}, but should point to ${server.ipv4}`
        });
      }
    }

    // DNS is correct: rewrite the project's whole vhost (every domain, not just this one — the
    // old per-domain write replaced example.com's config when www.example.com was verified)
    // and get whatever certificates are missing, the www / apex counterpart included.
    let ssh: SSHClient | null = null;
    try {
      ssh = new SSHClient();
      await ssh.connect({
        host: server.ipv4,
        port: 22,
        username: 'root',
        privateKey: decrypt(server.sshPrivateKey),
      });

      const projectSlug = project.slug || 'unknown';
      // Use the app's real published port (honors the project's PORT env), not just the
      // assigned port — otherwise the vhost proxies to the wrong port and 502s.
      const containerPort = await resolveProjectPort(ssh, projectId, projectSlug);

      if (!domain.isAutoGenerated) {
        await domainRepository.updateSslStatus(domainId, 'configuring');
      }

      logger.info({ domain: domain.domain, containerPort }, 'Configuring Nginx and SSL for project domains');
      const result = await syncProjectSites(ssh, {
        projectId,
        projectSlug,
        containerPort,
        serverIp: server.ipv4,
        requestCertificates: true,
      });
      ssh.disconnect();
      ssh = null;

      if (!result.success) {
        throw new Error(result.message);
      }

      // Verified once DNS checks out and Nginx serves it; sslStatus was set by the sync
      // ('failed' still leaves HTTP working).
      return await domainRepository.update(domainId, { verifiedAt: new Date() });
    } catch (error) {
      if (ssh) {
        ssh.disconnect();
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error({ domain: domain.domain, error: errorMessage }, 'Domain verification failed');

      await domainRepository.updateSslStatus(domainId, 'failed');
      throw new HTTPException(500, { message: errorMessage });
    }
  },

  /**
   * Delete domain
   */
  async delete(
    domainId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const project = await this.checkProjectAccess(projectId, organizationId, userId, locale, true);

    const domain = await domainRepository.findById(domainId);
    if (!domain || domain.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'notFound') });
    }

    // If deleting primary domain, set another one as primary
    if (domain.isPrimary) {
      const otherDomains = await domainRepository.findByProject(projectId);
      const newPrimary = otherDomains.find((d) => d.id !== domainId);
      if (newPrimary) {
        await domainRepository.setPrimary(projectId, newPrimary.id);
      }
    }

    await domainRepository.delete(domainId);

    // Rewrite the vhost without it. (This used to delete the project's whole vhost file,
    // taking every other domain of the project offline with it.)
    const targetServerId = resolveProjectServerId(project);
    if (targetServerId) {
      try {
        const server = await db.query.servers.findFirst({
          where: eq(servers.id, targetServerId),
        });

        if (server?.ipv4 && server?.sshPrivateKey && project.slug) {
          const ssh = new SSHClient();
          await ssh.connect({
            host: server.ipv4,
            port: 22,
            username: 'root',
            privateKey: decrypt(server.sshPrivateKey),
          });
          try {
            const containerPort = await resolveProjectPort(ssh, projectId, project.slug);
            const result = await syncProjectSites(ssh, {
              projectId,
              projectSlug: project.slug,
              containerPort,
              serverIp: server.ipv4,
            });
            if (!result.success) {
              logger.warn({ domainId, error: result.message }, 'Failed to update Nginx after domain delete');
            }
          } finally {
            ssh.disconnect();
          }
        }
      } catch (error) {
        // Log but don't fail - the domain is already gone from the database
        logger.warn({ domainId, error }, 'Failed to remove domain from Nginx');
      }
    }
  },

  /**
   * Get Nginx settings for a domain
   */
  async getNginxSettings(
    domainId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const domain = await domainRepository.findById(domainId);
    if (!domain || domain.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'notFound') });
    }

    return domain.nginxSettings || {};
  },

  /**
   * Update Nginx settings for a domain
   */
  async updateNginxSettings(
    domainId: string,
    projectId: string,
    organizationId: string,
    userId: string,
    settings: Record<string, unknown>,
    locale: SupportedLocale
  ) {
    const project = await this.checkProjectAccess(projectId, organizationId, userId, locale, true);

    const domain = await domainRepository.findById(domainId);
    if (!domain || domain.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'notFound') });
    }

    // Merge with existing settings
    const updatedSettings = { ...(domain.nginxSettings || {}), ...settings };

    // Update in database
    await domainRepository.updateNginxSettings(domainId, updatedSettings);

    // Apply to the server the app runs on (its own, or the shared runner)
    const targetServerId = resolveProjectServerId(project);
    if (targetServerId && project.slug) {
      try {
        const server = await db.query.servers.findFirst({
          where: eq(servers.id, targetServerId),
        });

        if (server?.ipv4 && server?.sshPrivateKey) {
          const ssh = new SSHClient();
          await ssh.connect({
            host: server.ipv4,
            port: 22,
            username: 'root',
            privateKey: decrypt(server.sshPrivateKey),
          });
          try {
            const containerPort = await resolveProjectPort(ssh, projectId, project.slug);
            const result = await syncProjectSites(ssh, {
              projectId,
              projectSlug: project.slug,
              containerPort,
              serverIp: server.ipv4,
            });
            if (!result.success) throw new Error(result.message);
          } finally {
            ssh.disconnect();
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ domainId, error: errorMessage }, 'Failed to apply Nginx settings');
        throw new HTTPException(500, { message: t(locale, 'domains', 'nginxUpdateFailed') });
      }
    }

    return updatedSettings;
  },
};
