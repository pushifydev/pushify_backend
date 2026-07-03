import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { searchProjectLogs } from '../workers/log-collector';
import { organizationRepository } from '../repositories/organization.repository';
import { projectRepository } from '../repositories/project.repository';
import { authMiddleware } from '../middleware/auth';
import { t } from '../i18n';
import type { AppEnv } from '../types';

const projectLogsRouter = new Hono<AppEnv>();

projectLogsRouter.use('*', authMiddleware);

// Search a project's persisted container logs (logs explorer history mode)
projectLogsRouter.get('/:projectId/logs/search', async (c) => {
  const userId = c.get('userId')!;
  const organizationId = c.get('organizationId')!;
  const locale = c.get('locale');
  const projectId = c.req.param('projectId');

  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
  }
  const project = await projectRepository.findById(projectId);
  if (!project || project.organizationId !== organizationId) {
    throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
  }

  const query = c.req.query('q') || undefined;
  const logTypeRaw = c.req.query('logType');
  const logType = logTypeRaw === 'stdout' || logTypeRaw === 'stderr' ? logTypeRaw : undefined;
  const rawLimit = parseInt(c.req.query('limit') || '500', 10);
  const maxLines = Number.isFinite(rawLimit) ? Math.min(1000, Math.max(1, rawLimit)) : 500;

  const result = await searchProjectLogs(projectId, { query, logType, maxLines });

  return c.json({
    data: {
      lines: result.lines.map((line) => ({
        content: line.content,
        timestamp: line.timestamp.toISOString(),
        logType: line.logType,
        deploymentId: line.deploymentId,
      })),
      scannedChunks: result.scannedChunks,
    },
  });
});

export { projectLogsRouter as projectLogsRoutes };
