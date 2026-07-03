import { eq } from 'drizzle-orm';
import { db } from '../db';
import { projectVolumes } from '../db/schema/project-volumes';
import { buildVolumeMount } from './volume-validate';

/**
 * The `-v` mount strings for a project's persistent volumes, applied by every container
 * start path (deploy, blue-green, quick rollback, local). Named volumes are created by
 * Docker on first use and survive container recreation.
 */
export async function getProjectVolumeMounts(projectId: string, projectSlug: string): Promise<string[]> {
  const volumes = await db
    .select()
    .from(projectVolumes)
    .where(eq(projectVolumes.projectId, projectId));
  return volumes.map((volume) => buildVolumeMount(projectSlug, volume.name, volume.containerPath));
}
