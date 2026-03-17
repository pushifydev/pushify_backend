import { HTTPException } from 'hono/http-exception';
import { promises as dns } from 'dns';
import { domainRepository } from '../repositories/domain.repository';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { projects } from '../db/schema/projects';
import { eq } from 'drizzle-orm';
import { SSHClient } from '../utils/ssh';
import { decrypt } from '../lib/encryption';
import { addSite, reloadNginx, requestSSLCertificate } from '../workers/nginx-manager';
import { getOrAssignPort } from '../workers/port-manager';
import { t, type SupportedLocale } from '../i18n';
import { logger } from '../lib/logger';

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
    locale: SupportedLocale
  ) {
    // Verify organization membership
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Verify project exists and belongs to organization
    const project = await projectRepository.findById(projectId);
    if (!project || project.organizationId !== organizationId || project.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

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

    // Get server IP
    let serverIp: string | null = null;
    if (project.serverId) {
      const server = await db.query.servers.findFirst({
        where: eq(servers.id, project.serverId),
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
   * Create new domain
   */
  async create(
    projectId: string,
    organizationId: string,
    userId: string,
    input: CreateDomainInput,
    locale: SupportedLocale
  ) {
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

    // Validate domain format
    const domainName = input.domain.toLowerCase().trim();
    if (!DOMAIN_REGEX.test(domainName)) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'invalidFormat') });
    }

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
    await this.checkProjectAccess(projectId, organizationId, userId, locale);

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
    const project = await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const domain = await domainRepository.findById(domainId);
    if (!domain || domain.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'notFound') });
    }

    // Check if project has a server assigned
    if (!project.serverId) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'noServerAssigned') });
    }

    // Get server details
    const server = await db.query.servers.findFirst({
      where: eq(servers.id, project.serverId),
    });

    if (!server || !server.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: t(locale, 'domains', 'serverNotReady') });
    }

    // Check DNS - domain should point to server IP
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

    // DNS is correct, now configure Nginx and SSL
    let ssh: SSHClient | null = null;
    try {
      ssh = new SSHClient();
      await ssh.connect({
        host: server.ipv4,
        port: 22,
        username: 'root',
        privateKey: decrypt(server.sshPrivateKey),
      });

      // Get project's port
      const projectData = await db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });
      const projectSlug = projectData?.slug || 'unknown';

      // Get assigned port for this project
      const { port: containerPort } = await getOrAssignPort(ssh, projectSlug);

      // Configure Nginx for HTTP first
      logger.info({ domain: domain.domain, containerPort }, 'Configuring Nginx for domain');

      const addResult = await addSite(ssh, {
        domain: domain.domain,
        containerPort,
        projectSlug,
        ssl: false,
        nginxSettings: domain.nginxSettings || {},
      });

      if (!addResult.success) {
        throw new Error(`Failed to configure Nginx: ${addResult.message}`);
      }

      // Reload Nginx
      const reloadResult = await reloadNginx(ssh);
      if (!reloadResult.success) {
        throw new Error(`Failed to reload Nginx: ${reloadResult.message}`);
      }

      // Update domain status to 'configuring'
      await domainRepository.updateSslStatus(domainId, 'configuring');

      // Request SSL certificate
      logger.info({ domain: domain.domain }, 'Requesting SSL certificate');

      const sslResult = await requestSSLCertificate(
        ssh,
        domain.domain,
        'ssl@pushify.app' // TODO: Use organization/user email
      );

      if (sslResult.success) {
        // Update Nginx config with SSL (preserve existing nginxSettings)
        await addSite(ssh, {
          domain: domain.domain,
          containerPort,
          projectSlug,
          ssl: true,
          nginxSettings: domain.nginxSettings || {},
        });
        await reloadNginx(ssh);

        // Update domain status
        await domainRepository.updateSslStatus(domainId, 'active');

        // Mark as verified
        const updatedDomain = await domainRepository.update(domainId, {
          verifiedAt: new Date(),
        });

        ssh.disconnect();
        return updatedDomain;
      } else {
        // SSL failed but HTTP works
        logger.warn({ domain: domain.domain, error: sslResult.message }, 'SSL certificate request failed');
        await domainRepository.updateSslStatus(domainId, 'failed');

        // Still mark as verified (HTTP works)
        const updatedDomain = await domainRepository.update(domainId, {
          verifiedAt: new Date(),
        });

        ssh.disconnect();
        return updatedDomain;
      }
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
    const project = await this.checkProjectAccess(projectId, organizationId, userId, locale);

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

    // Remove from Nginx if project has a server
    if (project.serverId) {
      try {
        const server = await db.query.servers.findFirst({
          where: eq(servers.id, project.serverId),
        });

        if (server?.ipv4 && server?.sshPrivateKey) {
          const ssh = new SSHClient();
          await ssh.connect({
            host: server.ipv4,
            port: 22,
            username: 'root',
            privateKey: decrypt(server.sshPrivateKey),
          });

          // Remove the site from Nginx
          const projectData = await db.query.projects.findFirst({
            where: eq(projects.id, projectId),
          });

          if (projectData?.slug) {
            const { removeSite } = await import('../workers/nginx-manager');
            await removeSite(ssh, projectData.slug);
            await reloadNginx(ssh);
          }

          ssh.disconnect();
        }
      } catch (error) {
        // Log but don't fail - domain should still be deleted from DB
        logger.warn({ domainId, error }, 'Failed to remove domain from Nginx');
      }
    }

    await domainRepository.delete(domainId);
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
    const project = await this.checkProjectAccess(projectId, organizationId, userId, locale);

    const domain = await domainRepository.findById(domainId);
    if (!domain || domain.projectId !== projectId) {
      throw new HTTPException(404, { message: t(locale, 'domains', 'notFound') });
    }

    // Merge with existing settings
    const updatedSettings = { ...(domain.nginxSettings || {}), ...settings };

    // Update in database
    await domainRepository.updateNginxSettings(domainId, updatedSettings);

    // Apply to server if domain is verified and project has a server
    if (domain.sslStatus === 'active' && project.serverId) {
      try {
        const server = await db.query.servers.findFirst({
          where: eq(servers.id, project.serverId),
        });

        if (server?.ipv4 && server?.sshPrivateKey) {
          const ssh = new SSHClient();
          await ssh.connect({
            host: server.ipv4,
            port: 22,
            username: 'root',
            privateKey: decrypt(server.sshPrivateKey),
          });

          // Get project slug and port
          const projectData = await db.query.projects.findFirst({
            where: eq(projects.id, projectId),
          });

          if (projectData?.slug) {
            const { port: containerPort } = await getOrAssignPort(ssh, projectData.slug);

            // Update Nginx configuration with new settings
            await addSite(ssh, {
              domain: domain.domain,
              containerPort,
              projectSlug: projectData.slug,
              ssl: domain.sslStatus === 'active',
              nginxSettings: updatedSettings,
            });

            await reloadNginx(ssh);
          }

          ssh.disconnect();
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
