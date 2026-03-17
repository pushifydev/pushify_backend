import { HTTPException } from 'hono/http-exception';
import crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { generateSlug } from '../lib/utils';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';

// Types
interface CreateProjectInput {
  name: string;
  description?: string;
  gitRepoUrl?: string;
  gitBranch?: string;
  gitProvider?: string;
  buildCommand?: string;
  startCommand?: string;
  rootDirectory?: string;
  dockerfilePath?: string;
  port?: number;
  autoDeploy?: boolean;
  serverId?: string; // Server to deploy to (optional)
}

interface UpdateProjectInput {
  name?: string;
  description?: string;
  gitRepoUrl?: string;
  gitBranch?: string;
  gitProvider?: string;
  buildCommand?: string;
  startCommand?: string;
  rootDirectory?: string;
  dockerfilePath?: string;
  port?: number;
  autoDeploy?: boolean;
  serverId?: string | null; // Server to deploy to (optional, null to remove)
}

export const projectService = {
  /**
   * Create a new project
   */
  async create(
    organizationId: string,
    userId: string,
    input: CreateProjectInput,
    locale: SupportedLocale = 'en'
  ) {
    // Verify user has access to organization
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Generate slug from name
    let slug = generateSlug(input.name);

    // Check if slug exists, append random suffix if needed
    const slugExists = await projectRepository.slugExists(organizationId, slug);
    if (slugExists) {
      slug = `${slug}-${Math.random().toString(36).substring(2, 6)}`;
    }

    // If serverId is provided, validate it belongs to the organization
    let validatedServerId: string | undefined;
    if (input.serverId) {
      const server = await db.query.servers.findFirst({
        where: and(
          eq(servers.id, input.serverId),
          eq(servers.organizationId, organizationId)
        ),
      });

      if (!server) {
        throw new HTTPException(400, { message: t(locale, 'projects', 'invalidServer') });
      }

      if (server.status !== 'running' || server.setupStatus !== 'completed') {
        throw new HTTPException(400, { message: t(locale, 'projects', 'serverNotReady') });
      }

      validatedServerId = input.serverId;
    }

    // Create project
    const project = await projectRepository.create({
      organizationId,
      slug,
      name: input.name,
      description: input.description,
      gitRepoUrl: input.gitRepoUrl,
      gitBranch: input.gitBranch || 'main',
      gitProvider: input.gitProvider,
      buildCommand: input.buildCommand,
      startCommand: input.startCommand,
      rootDirectory: input.rootDirectory || '/',
      dockerfilePath: input.dockerfilePath,
      port: input.port || 3000,
      autoDeploy: input.autoDeploy ?? true,
      serverId: validatedServerId,
    });

    logger.info({ projectId: project.id, userId }, 'Project created');

    return project;
  },

  /**
   * Get project by ID
   */
  async getById(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    // Verify user has access to organization
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const project = await projectRepository.findByIdWithDomains(projectId);

    if (!project || project.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    if (project.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    return project;
  },

  /**
   * Get all projects for organization
   */
  async getByOrganization(
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    // Verify user has access to organization
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    return projectRepository.findByOrganization(organizationId);
  },

  /**
   * Update project
   */
  async update(
    projectId: string,
    organizationId: string,
    userId: string,
    input: UpdateProjectInput,
    locale: SupportedLocale = 'en'
  ) {
    // Verify user has access to organization
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Check project exists and belongs to organization
    const existing = await projectRepository.findById(projectId);
    if (!existing || existing.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    if (existing.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    // Only allow certain roles to update
    if (!['owner', 'admin', 'member'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // If serverId is being updated, validate it
    let validatedServerId: string | null | undefined = input.serverId;

    if (input.serverId !== undefined && input.serverId !== null) {
      // Validate server belongs to organization
      const server = await db.query.servers.findFirst({
        where: and(
          eq(servers.id, input.serverId),
          eq(servers.organizationId, organizationId)
        ),
      });

      if (!server) {
        throw new HTTPException(400, { message: t(locale, 'projects', 'invalidServer') });
      }

      if (server.status !== 'running' || server.setupStatus !== 'completed') {
        throw new HTTPException(400, { message: t(locale, 'projects', 'serverNotReady') });
      }

      validatedServerId = input.serverId;
    }

    const project = await projectRepository.update(projectId, {
      ...input,
      serverId: validatedServerId,
    });

    logger.info({ projectId, userId }, 'Project updated');

    return project;
  },

  /**
   * Delete project (soft delete)
   */
  async delete(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    // Verify user has access to organization
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Check project exists and belongs to organization
    const existing = await projectRepository.findById(projectId);
    if (!existing || existing.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    // Only allow owner/admin to delete
    if (!['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    await projectRepository.softDelete(projectId);

    logger.info({ projectId, userId }, 'Project deleted');
  },

  /**
   * Pause/Resume project
   */
  async updateStatus(
    projectId: string,
    organizationId: string,
    userId: string,
    status: 'active' | 'paused',
    locale: SupportedLocale = 'en'
  ) {
    // Verify user has access to organization
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Check project exists and belongs to organization
    const existing = await projectRepository.findById(projectId);
    if (!existing || existing.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    if (existing.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    const project = await projectRepository.updateStatus(projectId, status);

    logger.info({ projectId, userId, status }, 'Project status updated');

    return project;
  },

  /**
   * Regenerate webhook secret
   */
  async regenerateWebhookSecret(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    // Verify user has access to organization
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Check project exists and belongs to organization
    const existing = await projectRepository.findById(projectId);
    if (!existing || existing.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    if (existing.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    // Generate new secret
    const secret = crypto.randomBytes(32).toString('hex');

    // Update project
    await projectRepository.updateWebhookSecret(projectId, secret);

    logger.info({ projectId, userId }, 'Webhook secret regenerated');

    return { secret };
  },

  /**
   * Update project settings
   */
  async updateSettings(
    projectId: string,
    organizationId: string,
    userId: string,
    settings: Record<string, unknown>,
    locale: SupportedLocale = 'en'
  ) {
    // Verify user has access to organization
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    // Check project exists and belongs to organization
    const existing = await projectRepository.findById(projectId);
    if (!existing || existing.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    if (existing.status === 'deleted') {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    // Only allow certain roles to update
    if (!['owner', 'admin', 'member'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
    }

    const project = await projectRepository.updateSettings(projectId, settings);

    logger.info({ projectId, userId, settings }, 'Project settings updated');

    return project;
  },
};
