import { Hono } from 'hono';
import { projectVolumeService } from '../services/project-volume.service';
import { authMiddleware } from '../middleware/auth';
import type { AppEnv } from '../types';

const projectVolumeRouter = new Hono<AppEnv>();

projectVolumeRouter.use('*', authMiddleware);

// List a project's volumes
projectVolumeRouter.get('/:projectId/volumes', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const volumes = await projectVolumeService.listVolumes(projectId, organizationId, userId, locale);
  return c.json({ data: volumes });
});

// Create a volume (takes effect on the next deploy)
projectVolumeRouter.post('/:projectId/volumes', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const body = await c.req.json();

  const volume = await projectVolumeService.createVolume(
    projectId,
    organizationId,
    userId,
    body,
    locale
  );
  return c.json({ data: volume }, 201);
});

// Delete a volume (detaches on the next deploy; data is removed on project teardown)
projectVolumeRouter.delete('/:projectId/volumes/:volumeId', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');
  const volumeId = c.req.param('volumeId');

  await projectVolumeService.deleteVolume(projectId, volumeId, organizationId, userId, locale);
  return c.json({ data: { deleted: true } });
});

export { projectVolumeRouter as projectVolumeRoutes };
