import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { projects, domains, environmentVariables } from '../db/schema/projects';
import { servers } from '../db/schema/servers';

// Types
export type CreateProjectInput = {
  organizationId: string;
  name: string;
  slug: string;
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
  serverId?: string;
};

export type UpdateProjectInput = {
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
  serverId?: string | null; // Allow null to clear server assignment
};

export type ProjectWithDomains = typeof projects.$inferSelect & {
  domains: (typeof domains.$inferSelect)[];
  server?: typeof servers.$inferSelect | null;
};

export const projectRepository = {
  // Find project by ID
  async findById(id: string) {
    return db.query.projects.findFirst({
      where: eq(projects.id, id),
    });
  },

  // Find project by ID with domains and server
  async findByIdWithDomains(id: string): Promise<ProjectWithDomains | undefined> {
    return db.query.projects.findFirst({
      where: eq(projects.id, id),
      with: {
        domains: true,
        server: true,
      },
    });
  },

  // Find project by slug within organization
  async findBySlug(organizationId: string, slug: string) {
    return db.query.projects.findFirst({
      where: and(
        eq(projects.organizationId, organizationId),
        eq(projects.slug, slug)
      ),
    });
  },

  // Find all projects for organization
  async findByOrganization(organizationId: string) {
    return db.query.projects.findMany({
      where: and(
        eq(projects.organizationId, organizationId),
        eq(projects.status, 'active')
      ),
      with: {
        domains: {
          where: eq(domains.isPrimary, true),
        },
      },
      orderBy: [desc(projects.updatedAt)],
    });
  },

  // Create project
  async create(input: CreateProjectInput) {
    const [project] = await db
      .insert(projects)
      .values(input)
      .returning();

    return project;
  },

  // Update project
  async update(id: string, data: UpdateProjectInput) {
    const [project] = await db
      .update(projects)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    return project;
  },

  // Soft delete project (set status to deleted)
  async softDelete(id: string) {
    const [project] = await db
      .update(projects)
      .set({ status: 'deleted', updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    return project;
  },

  // Hard delete project
  async delete(id: string) {
    await db.delete(projects).where(eq(projects.id, id));
  },

  // Check if slug exists in organization
  async slugExists(organizationId: string, slug: string, excludeId?: string) {
    const existing = await db.query.projects.findFirst({
      where: excludeId
        ? and(
            eq(projects.organizationId, organizationId),
            eq(projects.slug, slug),
            eq(projects.id, excludeId)
          )
        : and(
            eq(projects.organizationId, organizationId),
            eq(projects.slug, slug)
          ),
    });
    return !!existing;
  },

  // Update project status
  async updateStatus(id: string, status: 'active' | 'paused' | 'deleted') {
    const [project] = await db
      .update(projects)
      .set({ status, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    return project;
  },

  // Count projects in organization
  async countByOrganization(organizationId: string) {
    const result = await db.query.projects.findMany({
      where: and(
        eq(projects.organizationId, organizationId),
        eq(projects.status, 'active')
      ),
      columns: { id: true },
    });
    return result.length;
  },

  // Find project by Git URL (for webhooks)
  async findByGitUrl(gitRepoUrl: string) {
    // Normalize URL - handle both HTTPS and SSH formats
    const normalizedUrl = gitRepoUrl
      .replace(/\.git$/, '')
      .replace(/^git@github\.com:/, 'https://github.com/')
      .toLowerCase();

    return db.query.projects.findFirst({
      where: and(
        eq(projects.status, 'active')
      ),
      with: {
        organization: true,
      },
    }).then(async () => {
      // Need to do manual comparison for URL normalization
      const allProjects = await db.query.projects.findMany({
        where: eq(projects.status, 'active'),
      });

      return allProjects.find((p) => {
        if (!p.gitRepoUrl) return false;
        const projectUrl = p.gitRepoUrl
          .replace(/\.git$/, '')
          .replace(/^git@github\.com:/, 'https://github.com/')
          .toLowerCase();
        return projectUrl === normalizedUrl;
      });
    });
  },

  // Update webhook secret
  async updateWebhookSecret(id: string, webhookSecret: string) {
    const [project] = await db
      .update(projects)
      .set({ webhookSecret, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    return project;
  },

  // Update project settings (merge with existing)
  async updateSettings(id: string, newSettings: Record<string, unknown>) {
    // Get existing project to merge settings
    const existing = await this.findById(id);
    if (!existing) return null;

    const mergedSettings = {
      ...(existing.settings as Record<string, unknown> || {}),
      ...newSettings,
    };

    const [project] = await db
      .update(projects)
      .set({ settings: mergedSettings, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();

    return project;
  },
};
