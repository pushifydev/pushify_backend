import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { HTTPException } from 'hono/http-exception';
import { db } from '../db';
import { staticUploads } from '../db/schema';
import { projectRepository } from '../repositories/project.repository';
import { hasRunnerServers } from '../lib/runner-routing';
import { packSiteFiles, unpackSiteFiles, type SiteFile } from '../lib/static-upload';
import { logger } from '../lib/logger';
import type { SupportedLocale } from '../i18n';
import { projectService } from './project.service';
import { deploymentService } from './deployment.service';

/** Versions kept per project: enough to roll back a few publishes, bounded in the database. */
const KEPT_VERSIONS = 5;

export const isUploadProject = (settings: unknown): boolean =>
  (settings as Record<string, unknown> | null)?.staticSource === 'upload';

async function storeVersion(projectId: string, files: SiteFile[]) {
  const archive = packSiteFiles(files);
  const sizeBytes = files.reduce((sum, f) => sum + f.content.byteLength, 0);
  const [row] = await db
    .insert(staticUploads)
    .values({ projectId, archive, fileCount: files.length, sizeBytes })
    .returning({ id: staticUploads.id });
  return { id: row.id, fileCount: files.length, sizeBytes };
}

async function pruneVersions(projectId: string): Promise<void> {
  const keep = await db
    .select({ id: staticUploads.id })
    .from(staticUploads)
    .where(eq(staticUploads.projectId, projectId))
    .orderBy(desc(staticUploads.createdAt))
    .limit(KEPT_VERSIONS);
  if (keep.length < KEPT_VERSIONS) return;
  await db.delete(staticUploads).where(
    and(
      eq(staticUploads.projectId, projectId),
      notInArray(
        staticUploads.id,
        keep.map((k) => k.id),
      ),
    ),
  );
}

/** Store the files as a new version and publish it through the normal deployment pipeline. */
async function publishVersion(
  projectId: string,
  organizationId: string,
  userId: string,
  files: SiteFile[],
  locale: SupportedLocale,
) {
  const version = await storeVersion(projectId, files);
  try {
    const deployment = await deploymentService.create(
      projectId,
      organizationId,
      userId,
      {
        trigger: 'manual',
        commitHash: 'upload',
        commitMessage: `Upload · ${files.length} file${files.length === 1 ? '' : 's'}`,
      },
      locale,
    );
    await db.update(staticUploads).set({ deploymentId: deployment.id }).where(eq(staticUploads.id, version.id));
    await pruneVersions(projectId);
    return { deployment, version };
  } catch (err) {
    // No deployment (quota, billing): don't keep a version nobody can publish.
    await db.delete(staticUploads).where(eq(staticUploads.id, version.id));
    throw err;
  }
}

export const staticUploadService = {
  /** A new project from uploaded files: "drop a folder, get a URL". */
  async createProject(
    organizationId: string,
    userId: string,
    input: { name: string; serverId?: string },
    files: SiteFile[],
    locale: SupportedLocale,
  ) {
    // Without a server of its own the site goes to Pushify's shared runners; if there are none
    // (self-hosted Pushify), a server has to be chosen.
    if (!input.serverId && !hasRunnerServers()) {
      throw new HTTPException(400, { message: 'Choose a server to host the site on' });
    }

    const project = await projectService.create(
      organizationId,
      userId,
      { name: input.name, serverId: input.serverId, autoDeploy: false },
      locale,
    );
    await projectRepository.updateSettings(project.id, { static: true, staticSource: 'upload' });

    try {
      const { deployment, version } = await publishVersion(project.id, organizationId, userId, files, locale);
      logger.info({ projectId: project.id, files: version.fileCount, bytes: version.sizeBytes }, 'Static upload project created');
      return { project, deployment, fileCount: version.fileCount, sizeBytes: version.sizeBytes };
    } catch (err) {
      // The project was only a container for this upload; don't leave an empty one behind.
      await projectRepository.updateStatus(project.id, 'deleted').catch(() => undefined);
      throw err;
    }
  },

  /** Replace an uploaded site with new files (a new version, published like any deploy). */
  async uploadVersion(
    projectId: string,
    organizationId: string,
    userId: string,
    files: SiteFile[],
    locale: SupportedLocale,
  ) {
    const project = await projectService.getById(projectId, organizationId, userId, locale);
    if (!isUploadProject(project.settings)) {
      throw new HTTPException(400, { message: 'This project deploys from Git or an image, not from uploaded files' });
    }
    const { deployment, version } = await publishVersion(projectId, organizationId, userId, files, locale);
    return { deployment, fileCount: version.fileCount, sizeBytes: version.sizeBytes };
  },

  /**
   * The files a deployment publishes: the version uploaded with it; for a rollback, the version
   * of the deployment rolled back to; for a plain redeploy, the newest version.
   */
  async filesForDeployment(
    projectId: string,
    deploymentId: string,
    rollbackFromDeploymentId: string | null,
  ): Promise<SiteFile[] | null> {
    const wanted = [deploymentId, rollbackFromDeploymentId].filter((x): x is string => !!x);
    const [linked] = await db
      .select({ archive: staticUploads.archive, deploymentId: staticUploads.deploymentId })
      .from(staticUploads)
      .where(and(eq(staticUploads.projectId, projectId), inArray(staticUploads.deploymentId, wanted)))
      .orderBy(desc(staticUploads.createdAt))
      .limit(2);
    if (linked) return unpackSiteFiles(linked.archive);

    const [latest] = await db
      .select({ archive: staticUploads.archive })
      .from(staticUploads)
      .where(eq(staticUploads.projectId, projectId))
      .orderBy(desc(staticUploads.createdAt))
      .limit(1);
    return latest ? unpackSiteFiles(latest.archive) : null;
  },
};
