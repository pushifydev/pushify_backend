import { db } from '../db';
import { projects, deployments, environmentVariables, marketplaceDeployments } from '../db/schema';
import { templates, getTemplateById } from '../marketplace/templates';
import { generatePassword, generateSecret } from '../marketplace/helpers';
import type { MarketplaceCategory } from '../marketplace/types';
import { encrypt } from '../lib/encryption';
import { eq, and } from 'drizzle-orm';
import { logger } from '../lib/logger';

export const marketplaceService = {
  getTemplates(category?: string, search?: string) {
    let result = [...templates];

    if (category && category !== 'all') {
      result = result.filter((t) => t.category === category);
    }

    if (search) {
      const q = search.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q))
      );
    }

    return result;
  },

  getTemplate(id: string) {
    return getTemplateById(id);
  },

  async deploy(params: {
    organizationId: string;
    userId: string;
    templateId: string;
    serverId: string;
    name: string;
    envVars: Record<string, string>;
    domain?: string;
  }) {
    const template = getTemplateById(params.templateId);
    if (!template) {
      throw new Error(`Template '${params.templateId}' not found`);
    }

    // Generate slug from name
    const slug = params.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Generate values for auto-generate env vars
    const finalEnvVars: Record<string, string> = { ...params.envVars };
    for (const envVar of template.envVars) {
      if (envVar.generate && !finalEnvVars[envVar.key]) {
        finalEnvVars[envVar.key] = envVar.generate === 'password'
          ? generatePassword()
          : generateSecret();
      }
      if (envVar.default && !finalEnvVars[envVar.key]) {
        finalEnvVars[envVar.key] = envVar.default;
      }
    }

    // Create project
    const [project] = await db
      .insert(projects)
      .values({
        organizationId: params.organizationId,
        serverId: params.serverId,
        name: params.name,
        slug,
        framework: 'other',
        repoUrl: template.website,
        status: 'active',
        port: template.port,
        settings: {
          marketplaceTemplateId: template.id,
          dockerImage: template.dockerImage,
          dockerCommand: template.dockerCommand || null,
          volumes: template.volumes || [],
          healthCheckPath: template.healthCheckPath,
        },
      })
      .returning();

    // Create encrypted env vars
    if (Object.keys(finalEnvVars).length > 0) {
      const envVarInserts = Object.entries(finalEnvVars).map(([key, value]) => ({
        projectId: project.id,
        key,
        value: encrypt(value),
        environment: 'production' as const,
      }));

      await db.insert(environmentVariables).values(envVarInserts);
    }

    // Create marketplace deployment record
    const [mpDeployment] = await db
      .insert(marketplaceDeployments)
      .values({
        projectId: project.id,
        templateId: template.id,
        templateVersion: template.version,
        appVersion: template.appVersion,
        configuration: finalEnvVars,
      })
      .returning();

    // Create deployment to trigger the worker
    const [deployment] = await db
      .insert(deployments)
      .values({
        projectId: project.id,
        status: 'pending',
        trigger: 'manual',
        commitSha: `marketplace-${template.id}-${template.appVersion}`,
        commitMessage: `Deploy ${template.name} v${template.appVersion} from Marketplace`,
      })
      .returning();

    logger.info(`Marketplace deploy: ${template.name} -> project ${project.id}`);

    return {
      project,
      deployment,
      marketplaceDeployment: mpDeployment,
    };
  },

  async getDeployments(organizationId: string) {
    const result = await db
      .select()
      .from(marketplaceDeployments)
      .innerJoin(projects, eq(marketplaceDeployments.projectId, projects.id))
      .where(eq(projects.organizationId, organizationId));

    return result.map((r) => ({
      ...r.marketplace_deployments,
      project: r.projects,
    }));
  },
};
