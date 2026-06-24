import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { projects, servers, deployments } from '../db/schema';
import { siteStudioTemplates, getSiteTemplateById } from '../sites/templates';
import type { SiteStudioCategory, SiteStudioStack, SiteStudioTemplate } from '../sites/types';
import { marketplaceService } from './marketplace.service';
import { domainService } from './domain.service';
import { getTemplateById } from '../marketplace/templates';
import { logger } from '../lib/logger';
import { siteEditorService } from './site-editor.service';
import { generateSlug } from '../lib/utils';
import { scheduleDeploymentProcessing } from '../lib/deployment-scheduler';
import { projectRepository } from '../repositories/project.repository';

export const siteStudioService = {
  getTemplates(category?: string, search?: string, stack?: string) {
    let result = [...siteStudioTemplates];

    if (category && category !== 'all') {
      result = result.filter((t) => t.category === category);
    }

    if (stack && stack !== 'all') {
      result = result.filter((t) => t.stack === stack);
    }

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.tagline.toLowerCase().includes(q) ||
          t.stack.toLowerCase().includes(q) ||
          t.features.some((f) => f.toLowerCase().includes(q))
      );
    }

    return result;
  },

  getStacks(): SiteStudioStack[] {
    return ['static', 'wordpress', 'ghost', 'strapi', 'directus', 'pocketbase', 'calcom'];
  },

  getStackSummary() {
    const stacks = this.getStacks();
    return stacks.map((stack) => ({
      stack,
      count: siteStudioTemplates.filter((t) => t.stack === stack).length,
    }));
  },

  getTemplate(id: string) {
    return getSiteTemplateById(id);
  },

  getCategories(): SiteStudioCategory[] {
    return [
      'ecommerce',
      'corporate',
      'blog',
      'portfolio',
      'restaurant',
      'newsletter',
      'booking',
      'saas',
    ];
  },

  async launch(params: {
    organizationId: string;
    userId: string;
    siteTemplateId: string;
    serverId: string;
    name: string;
    domain?: string;
    envVars?: Record<string, string>;
    locale?: 'en' | 'tr';
  }) {
    const siteTemplate = getSiteTemplateById(params.siteTemplateId);
    if (!siteTemplate) {
      throw new Error(`Site template '${params.siteTemplateId}' not found`);
    }

    // Static sites (no CMS app) take a dedicated path: create the project, render the
    // block design to HTML and serve it directly from Nginx — no container is deployed.
    if (siteTemplate.deployment === 'static') {
      return this.launchStatic(params, siteTemplate);
    }

    const marketplaceTemplate = getTemplateById(siteTemplate.marketplaceTemplateId ?? '');
    if (!marketplaceTemplate) {
      throw new Error(`Underlying app '${siteTemplate.marketplaceTemplateId}' is not available`);
    }

    const envVars: Record<string, string> = {
      ...(siteTemplate.presetEnvVars ?? {}),
      ...(params.envVars ?? {}),
    };

    const normalizedDomain = params.domain?.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/$/, '');

    if (normalizedDomain) {
      const baseUrl = `https://${normalizedDomain}`;
      switch (siteTemplate.marketplaceTemplateId) {
        case 'ghost':
          envVars.url = baseUrl;
          break;
        case 'calcom':
          envVars.NEXT_PUBLIC_WEBAPP_URL = baseUrl;
          break;
        default:
          break;
      }
    }

    const deployResult = await marketplaceService.deploy({
      organizationId: params.organizationId,
      userId: params.userId,
      templateId: marketplaceTemplate.id,
      serverId: params.serverId,
      name: params.name,
      envVars,
      domain: normalizedDomain,
    });

    const projectId = deployResult.project.id;

    const existingSettings = (deployResult.project.settings as Record<string, unknown>) || {};
    await db
      .update(projects)
      .set({
        settings: {
          ...existingSettings,
          siteStudioTemplateId: siteTemplate.id,
          siteStudioCategory: siteTemplate.category,
          siteStudioStack: siteTemplate.stack,
        },
        updatedAt: new Date(),
      })
      .where(eq(projects.id, projectId));

    let domainRecord = null;
    if (normalizedDomain) {
      try {
        domainRecord = await domainService.create(
          projectId,
          params.organizationId,
          params.userId,
          { domain: normalizedDomain, isPrimary: true },
          params.locale ?? 'en'
        );
      } catch (err: any) {
        logger.warn({ projectId, domain: normalizedDomain, err: err.message }, 'Site Studio: domain attach failed');
      }
    }

    try {
      await siteEditorService.initializeForProject(
        projectId,
        siteTemplate.id,
        params.name,
        {
          title: params.name,
          description: siteTemplate.tagline,
        },
      );
    } catch (err) {
      logger.warn({ err, projectId }, 'Site Studio: site editor init failed');
    }

    logger.info(
      { projectId, siteTemplateId: siteTemplate.id },
      `Site Studio launch: ${siteTemplate.name}`
    );

    return {
      ...deployResult,
      siteTemplate,
      domain: domainRecord,
      setupGuide: siteTemplate.setupGuide,
      paymentIntegrations: siteTemplate.paymentIntegrations ?? [],
      suggestedPlugins: siteTemplate.suggestedPlugins ?? [],
    };
  },

  /**
   * Launch a Pushify-native static site: create the project, seed the block editor with the
   * template's design, render it to HTML and serve it directly from Nginx. No CMS container.
   */
  async launchStatic(
    params: {
      organizationId: string;
      userId: string;
      siteTemplateId: string;
      serverId: string;
      name: string;
      domain?: string;
      envVars?: Record<string, string>;
      locale?: 'en' | 'tr';
    },
    siteTemplate: SiteStudioTemplate,
  ) {
    // Domain is optional — without one the site is served on http://<server-ip>:<port>,
    // exactly like an app deploy.
    const normalizedDomain =
      params.domain?.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/$/, '') || null;

    // The target server must belong to this organization.
    const server = await db.query.servers.findFirst({
      where: and(eq(servers.id, params.serverId), eq(servers.organizationId, params.organizationId)),
    });
    if (!server) {
      throw new Error(`Server '${params.serverId}' not found`);
    }
    if (!server.ipv4 || !server.sshPrivateKey) {
      throw new Error('Server is not ready yet (missing IP or SSH key).');
    }

    // Unique slug within the org.
    let slug = generateSlug(params.name);
    if (await projectRepository.slugExists(params.organizationId, slug)) {
      slug = `${slug}-${Math.random().toString(36).substring(2, 6)}`;
    }

    // Create the project — no container, no deployment.
    const [project] = await db
      .insert(projects)
      .values({
        organizationId: params.organizationId,
        serverId: params.serverId,
        name: params.name,
        slug,
        status: 'active',
        settings: {
          siteStudioTemplateId: siteTemplate.id,
          siteStudioCategory: siteTemplate.category,
          siteStudioStack: 'static',
          static: true,
          productionUrl: `https://${normalizedDomain}`,
        },
      })
      .returning();

    // Seed the block editor with the template's design + theme.
    await siteEditorService.initializeForProject(project.id, siteTemplate.id, params.name, {
      title: params.name,
      description: siteTemplate.tagline,
    });

    // Record the domain (only when one was provided).
    let domainRecord = null;
    if (normalizedDomain) {
      try {
        domainRecord = await domainService.create(
          project.id,
          params.organizationId,
          params.userId,
          { domain: normalizedDomain, isPrimary: true },
          params.locale ?? 'en',
        );
      } catch (err: any) {
        logger.warn(
          { projectId: project.id, domain: normalizedDomain, err: err?.message },
          'Static launch: domain attach failed',
        );
      }
    }

    // Publishing runs through the deployment pipeline (same as CMS sites): create a pending
    // deployment and schedule it. The worker renders the HTML, configures Nginx and opens the
    // port — so the publish shows up under Deployments with status and logs.
    const [deployment] = await db
      .insert(deployments)
      .values({
        projectId: project.id,
        status: 'pending',
        trigger: 'manual',
        commitHash: 'static',
        commitMessage: `Publish ${siteTemplate.name}`,
      })
      .returning();

    await scheduleDeploymentProcessing(deployment.id, project.id);

    logger.info(
      { projectId: project.id, slug, domain: normalizedDomain, deploymentId: deployment.id },
      `Site Studio static launch: ${siteTemplate.name}`,
    );

    return {
      project,
      deployment,
      siteTemplate,
      domain: domainRecord,
      static: true,
      setupGuide: siteTemplate.setupGuide,
      paymentIntegrations: siteTemplate.paymentIntegrations ?? [],
      suggestedPlugins: siteTemplate.suggestedPlugins ?? [],
    };
  },
};
