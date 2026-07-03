import { HTTPException } from 'hono/http-exception';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { projectVolumes } from '../db/schema/project-volumes';
import { organizationRepository } from '../repositories/organization.repository';
import { projectRepository } from '../repositories/project.repository';
import { validateVolumeName, validateContainerPath } from '../lib/volume-validate';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';

const MAX_VOLUMES_PER_PROJECT = 5;

async function assertProjectAccess(
  projectId: string,
  organizationId: string,
  userId: string,
  locale: SupportedLocale
) {
  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
  }
  const project = await projectRepository.findById(projectId);
  if (!project || project.organizationId !== organizationId) {
    throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
  }
  return project;
}

export const projectVolumeService = {
  async listVolumes(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    await assertProjectAccess(projectId, organizationId, userId, locale);
    return db
      .select()
      .from(projectVolumes)
      .where(eq(projectVolumes.projectId, projectId))
      .orderBy(desc(projectVolumes.createdAt));
  },

  async createVolume(
    projectId: string,
    organizationId: string,
    userId: string,
    input: { name?: string; containerPath?: string },
    locale: SupportedLocale = 'en'
  ) {
    await assertProjectAccess(projectId, organizationId, userId, locale);

    const name = input.name?.trim() ?? '';
    const containerPath = input.containerPath?.trim() ?? '';

    const nameError = validateVolumeName(name);
    if (nameError) throw new HTTPException(400, { message: nameError });
    const pathError = validateContainerPath(containerPath);
    if (pathError) throw new HTTPException(400, { message: pathError });

    const existing = await db
      .select()
      .from(projectVolumes)
      .where(eq(projectVolumes.projectId, projectId));
    if (existing.length >= MAX_VOLUMES_PER_PROJECT) {
      throw new HTTPException(400, {
        message: `A project can have at most ${MAX_VOLUMES_PER_PROJECT} volumes`,
      });
    }
    if (existing.some((v) => v.name === name)) {
      throw new HTTPException(400, { message: `A volume named "${name}" already exists` });
    }
    if (existing.some((v) => v.containerPath === containerPath)) {
      throw new HTTPException(400, { message: `A volume is already mounted at ${containerPath}` });
    }

    const [volume] = await db
      .insert(projectVolumes)
      .values({ projectId, name, containerPath })
      .returning();

    logger.info({ volumeId: volume.id, projectId, userId }, 'Project volume created');
    return volume;
  },

  async deleteVolume(
    projectId: string,
    volumeId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    await assertProjectAccess(projectId, organizationId, userId, locale);
    const [volume] = await db
      .select()
      .from(projectVolumes)
      .where(and(eq(projectVolumes.id, volumeId), eq(projectVolumes.projectId, projectId)))
      .limit(1);
    if (!volume) {
      throw new HTTPException(404, { message: 'Volume not found' });
    }
    await db
      .delete(projectVolumes)
      .where(and(eq(projectVolumes.id, volumeId), eq(projectVolumes.projectId, projectId)));
    logger.info({ volumeId, projectId, userId }, 'Project volume deleted');
  },
};
