import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projects } from '../db/schema';
import { siteStudioTemplates, getSiteTemplateById } from '../sites/templates';
import type { SiteStudioCategory, SiteStudioStack } from '../sites/types';
import { marketplaceService } from './marketplace.service';
import { domainService } from './domain.service';
import { getTemplateById } from '../marketplace/templates';
import { logger } from '../lib/logger';
import { siteEditorService } from './site-editor.service';

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
    return ['wordpress', 'ghost', 'strapi', 'directus', 'pocketbase', 'calcom'];
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

    const marketplaceTemplate = getTemplateById(siteTemplate.marketplaceTemplateId);
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
      templateId: siteTemplate.marketplaceTemplateId,
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
};
