import crypto from 'crypto';
import { db } from '../db';
import { projects, deployments, environmentVariables, marketplaceDeployments, servers } from '../db/schema';
import { templates, getTemplateById } from '../marketplace/templates';
import { generatePassword, generateSecret, applyCalcomEnvDefaults } from '../marketplace/helpers';
import { encrypt } from '../lib/encryption';
import { omitWebhookSecret } from '../lib/project-public';
import { eq, and, desc } from 'drizzle-orm';
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

    // Verify the target server belongs to this organization
    // (prevents deploying onto another tenant's infrastructure via a forged serverId)
    const server = await db.query.servers.findFirst({
      where: and(
        eq(servers.id, params.serverId),
        eq(servers.organizationId, params.organizationId)
      ),
    });
    if (!server) {
      throw new Error(`Server '${params.serverId}' not found`);
    }

    // Generate unique slug from name + random suffix
    const baseSlug = params.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
    const suffix = Math.random().toString(36).substring(2, 8);
    const slug = `${baseSlug}-${suffix}`;

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

    if (template.id === 'calcom') {
      Object.assign(finalEnvVars, applyCalcomEnvDefaults(finalEnvVars));
    }

    // ── Supabase-specific: ANON_KEY and SERVICE_ROLE_KEY must be valid JWTs
    //    signed with JWT_SECRET (not random secrets)
    if (template.id === 'supabase') {
      const { SignJWT } = await import('jose');
      const secret = new TextEncoder().encode(finalEnvVars.JWT_SECRET);
      const now = Math.floor(Date.now() / 1000);
      const tenYears = 60 * 60 * 24 * 365 * 10;

      finalEnvVars.ANON_KEY = await new SignJWT({ iss: 'supabase', ref: 'pushify', role: 'anon' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt(now)
        .setExpirationTime(now + tenYears)
        .sign(secret);

      finalEnvVars.SERVICE_ROLE_KEY = await new SignJWT({ iss: 'supabase', ref: 'pushify', role: 'service_role' })
        .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
        .setIssuedAt(now)
        .setExpirationTime(now + tenYears)
        .sign(secret);
    }

    // Create project
    const isCompose = template.deploymentType === 'docker-compose';
    const webhookSecret = crypto.randomBytes(32).toString('hex');
    const [project] = await db
      .insert(projects)
      .values({
        organizationId: params.organizationId,
        serverId: params.serverId,
        name: params.name,
        slug,
        gitRepoUrl: template.website,
        webhookSecret,
        status: 'active',
        port: isCompose ? (template.composePublicPort || template.port) : template.port,
        settings: {
          marketplaceTemplateId: template.id,
          deploymentType: template.deploymentType || 'single-container',
          dockerImage: template.dockerImage,
          dockerCommand: template.dockerCommand || null,
          composeFile: template.composeFile || null,
          composePublicService: template.composePublicService || null,
          composePublicPort: template.composePublicPort || null,
          extraFiles: template.extraFiles || null,
          postDeploySql: template.postDeploySql || null,
          postDeployShell: template.postDeployShell || null,
          volumes: template.volumes || [],
          healthCheckPath: template.healthCheckPath,
          requiresDatabase: template.requiresDatabase || null,
        },
      })
      .returning();

    // Create encrypted env vars
    if (Object.keys(finalEnvVars).length > 0) {
      const envVarInserts = Object.entries(finalEnvVars).map(([key, value]) => ({
        projectId: project.id,
        key,
        valueEncrypted: encrypt(value),
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
        commitHash: `marketplace-${template.id}`,
        commitMessage: `Deploy ${template.name} v${template.appVersion} from Marketplace`,
      })
      .returning();

    const { scheduleDeploymentProcessing } = await import('../lib/deployment-scheduler');
    await scheduleDeploymentProcessing(deployment.id, project.id);

    logger.info(`Marketplace deploy: ${template.name} -> project ${project.id}`);

    return {
      project: omitWebhookSecret(project),
      deployment,
      marketplaceDeployment: mpDeployment,
    };
  },

  async getDeployments(organizationId: string) {
    const result = await db
      .select()
      .from(marketplaceDeployments)
      .innerJoin(projects, eq(marketplaceDeployments.projectId, projects.id))
      .where(eq(projects.organizationId, organizationId))
      .orderBy(desc(marketplaceDeployments.createdAt));

    return result.map((r) => {
      const template = getTemplateById(r.marketplace_deployments.templateId);
      return {
        ...r.marketplace_deployments,
        templateName: template?.name ?? r.marketplace_deployments.templateId,
        templateIcon: template?.icon ?? '📦',
        templateCategory: template?.category ?? null,
        project: omitWebhookSecret(r.projects),
      };
    });
  },
};
