import { HTTPException } from 'hono/http-exception';
import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { projectWorkers } from '../db/schema/project-workers';
import { projectRepository } from '../repositories/project.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { t, type SupportedLocale } from '../i18n';
import { assertMemberProjectScope } from '../lib/member-project-scope';
import { execOnProjectHost } from '../lib/project-host-exec';
import { logger } from '../lib/logger';
import {
  MAX_WORKERS_PER_PROJECT,
  validateWorkerName,
  validateWorkerCommand,
  workerContainerName,
} from '../lib/worker-validate';

interface WorkerInput {
  name?: string;
  command?: string;
  enabled?: boolean;
}

async function assertProjectAccess(
  projectId: string,
  organizationId: string,
  userId: string,
  locale: SupportedLocale,
  requireWrite = false
) {
  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: t(locale, 'organizations', 'noAccess') });
  }

  // Writes require a non-viewer role — viewer is read-only
  if (requireWrite && !['owner', 'admin', 'member'].includes(membership.role)) {
    throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
  }

  const project = await projectRepository.findById(projectId);
  if (!project || project.organizationId !== organizationId || project.status === 'deleted') {
    throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
  }

  await assertMemberProjectScope(membership, organizationId, userId, projectId, locale);

  return project;
}

/** Best-effort removal of a worker's container on the deploy host — never throws */
async function removeWorkerContainer(
  project: Awaited<ReturnType<typeof projectRepository.findById>> & object,
  name: string
) {
  const containerName = workerContainerName(project.slug, name);
  try {
    await execOnProjectHost(project, `docker rm -f ${containerName} 2>/dev/null || true`);
  } catch (err) {
    logger.warn({ projectId: project.id, worker: name, err }, 'Worker container removal failed');
  }
}

export const projectWorkerService = {
  async listWorkers(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    await assertProjectAccess(projectId, organizationId, userId, locale);
    return db
      .select()
      .from(projectWorkers)
      .where(eq(projectWorkers.projectId, projectId))
      .orderBy(projectWorkers.createdAt);
  },

  async createWorker(
    projectId: string,
    organizationId: string,
    userId: string,
    input: WorkerInput,
    locale: SupportedLocale = 'en'
  ) {
    await assertProjectAccess(projectId, organizationId, userId, locale, true);

    const nameError = validateWorkerName(input.name);
    if (nameError) throw new HTTPException(400, { message: nameError });
    const commandError = validateWorkerCommand(input.command);
    if (commandError) throw new HTTPException(400, { message: commandError });

    const existing = await db
      .select({ id: projectWorkers.id, name: projectWorkers.name })
      .from(projectWorkers)
      .where(eq(projectWorkers.projectId, projectId));

    if (existing.length >= MAX_WORKERS_PER_PROJECT) {
      throw new HTTPException(400, {
        message: `Worker limit reached (max ${MAX_WORKERS_PER_PROJECT} per project)`,
      });
    }
    if (existing.some((w) => w.name === input.name)) {
      throw new HTTPException(409, { message: `Worker "${input.name}" already exists` });
    }

    const [worker] = await db
      .insert(projectWorkers)
      .values({
        projectId,
        name: input.name!,
        command: input.command!,
        enabled: input.enabled !== false,
      })
      .returning();

    logger.info({ projectId, worker: worker.name, userId }, 'Worker created');
    return worker;
  },

  async updateWorker(
    projectId: string,
    workerId: string,
    organizationId: string,
    userId: string,
    input: WorkerInput,
    locale: SupportedLocale = 'en'
  ) {
    const project = await assertProjectAccess(projectId, organizationId, userId, locale, true);

    const worker = await db.query.projectWorkers.findFirst({
      where: and(eq(projectWorkers.id, workerId), eq(projectWorkers.projectId, projectId)),
    });
    if (!worker) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    if (input.command !== undefined) {
      const commandError = validateWorkerCommand(input.command);
      if (commandError) throw new HTTPException(400, { message: commandError });
    }

    const [updated] = await db
      .update(projectWorkers)
      .set({
        ...(input.command !== undefined ? { command: input.command } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        updatedAt: new Date(),
      })
      .where(eq(projectWorkers.id, workerId))
      .returning();

    // Disabling stops the container right away; enable/command changes apply on next deploy
    if (input.enabled === false && worker.enabled) {
      await removeWorkerContainer(project, worker.name);
    }

    logger.info({ projectId, worker: worker.name, userId, input }, 'Worker updated');
    return updated;
  },

  async deleteWorker(
    projectId: string,
    workerId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    const project = await assertProjectAccess(projectId, organizationId, userId, locale, true);

    const worker = await db.query.projectWorkers.findFirst({
      where: and(eq(projectWorkers.id, workerId), eq(projectWorkers.projectId, projectId)),
    });
    if (!worker) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    await db.delete(projectWorkers).where(eq(projectWorkers.id, workerId));
    await removeWorkerContainer(project, worker.name);

    logger.info({ projectId, worker: worker.name, userId }, 'Worker deleted');
  },

  /** Live container states for the project's workers, keyed by worker name */
  async getWorkerStatuses(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    const project = await assertProjectAccess(projectId, organizationId, userId, locale);

    const prefix = `pushify-${project.slug}-worker-`;
    const result = await execOnProjectHost(
      project,
      `docker ps -a --format '{{.Names}}\t{{.State}}\t{{.Status}}' | grep '^${prefix}' || true`
    );

    const statuses: Record<string, { state: string; status: string }> = {};
    if (result.ok) {
      for (const line of result.stdout.split('\n')) {
        const [name, state, ...status] = line.trim().split('\t');
        if (name?.startsWith(prefix)) {
          statuses[name.slice(prefix.length)] = {
            state: state || 'unknown',
            status: status.join(' ') || '',
          };
        }
      }
    }
    return statuses;
  },

  /** Tail a worker container's logs (on demand — workers are not in the log collector) */
  async getWorkerLogs(
    projectId: string,
    workerId: string,
    organizationId: string,
    userId: string,
    tail: number,
    locale: SupportedLocale = 'en'
  ) {
    const project = await assertProjectAccess(projectId, organizationId, userId, locale);

    const worker = await db.query.projectWorkers.findFirst({
      where: and(eq(projectWorkers.id, workerId), eq(projectWorkers.projectId, projectId)),
    });
    if (!worker) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    const lines = Math.min(500, Math.max(10, tail || 100));
    const containerName = workerContainerName(project.slug, worker.name);
    const result = await execOnProjectHost(
      project,
      `docker logs --tail ${lines} ${containerName} 2>&1 || true`
    );

    return { logs: result.stdout ?? '', containerName };
  },
};
