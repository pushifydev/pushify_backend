import { HTTPException } from 'hono/http-exception';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db';
import { scheduledTasks, scheduledTaskRuns } from '../db/schema/scheduled-tasks';
import { organizationRepository } from '../repositories/organization.repository';
import { projectRepository } from '../repositories/project.repository';
import { validateCronExpression, nextCronRun } from '../lib/cron-schedule';
import { logger } from '../lib/logger';
import { t, type SupportedLocale } from '../i18n';
import { assertMemberProjectScope } from '../lib/member-project-scope';

/** Flat per-project cap — generous for real use, low enough to stop abuse. */
const MAX_TASKS_PER_PROJECT = 10;
const MIN_TIMEOUT_SECONDS = 10;
const MAX_TIMEOUT_SECONDS = 600;

export interface ScheduledTaskInput {
  name?: string;
  type?: 'command' | 'http';
  schedule?: string;
  timezone?: string;
  command?: string | null;
  httpUrl?: string | null;
  timeoutSeconds?: number;
  enabled?: boolean;
}

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
  await assertMemberProjectScope(membership, organizationId, userId, projectId, locale);
  return project;
}

function validateTaskFields(input: ScheduledTaskInput, isCreate: boolean): void {
  if (isCreate || input.name !== undefined) {
    if (!input.name?.trim() || input.name.trim().length > 255) {
      throw new HTTPException(400, { message: 'Task name is required (max 255 chars)' });
    }
  }

  if (isCreate && input.type !== 'command' && input.type !== 'http') {
    throw new HTTPException(400, { message: "Task type must be 'command' or 'http'" });
  }

  if (isCreate || input.schedule !== undefined || input.timezone !== undefined) {
    const schedule = input.schedule ?? '';
    const error = validateCronExpression(schedule, input.timezone ?? 'UTC');
    if (isCreate && error) {
      throw new HTTPException(400, { message: error });
    }
    if (!isCreate && input.schedule !== undefined && error) {
      throw new HTTPException(400, { message: error });
    }
  }

  if (isCreate && input.type === 'command' && !input.command?.trim()) {
    throw new HTTPException(400, { message: 'Command is required for command tasks' });
  }
  if (input.command && input.command.length > 2000) {
    throw new HTTPException(400, { message: 'Command too long (max 2000 chars)' });
  }

  if (isCreate && input.type === 'http' && !input.httpUrl?.trim()) {
    throw new HTTPException(400, { message: 'URL is required for HTTP tasks' });
  }
  if (input.httpUrl) {
    let url: URL;
    try {
      url = new URL(input.httpUrl);
    } catch {
      throw new HTTPException(400, { message: 'Invalid URL' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new HTTPException(400, { message: 'URL must be http(s)' });
    }
  }

  if (input.timeoutSeconds !== undefined) {
    if (
      !Number.isInteger(input.timeoutSeconds) ||
      input.timeoutSeconds < MIN_TIMEOUT_SECONDS ||
      input.timeoutSeconds > MAX_TIMEOUT_SECONDS
    ) {
      throw new HTTPException(400, {
        message: `Timeout must be ${MIN_TIMEOUT_SECONDS}-${MAX_TIMEOUT_SECONDS} seconds`,
      });
    }
  }
}

export const scheduledTaskService = {
  async listTasks(
    projectId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    await assertProjectAccess(projectId, organizationId, userId, locale);
    return db
      .select()
      .from(scheduledTasks)
      .where(eq(scheduledTasks.projectId, projectId))
      .orderBy(desc(scheduledTasks.createdAt));
  },

  async createTask(
    projectId: string,
    organizationId: string,
    userId: string,
    input: ScheduledTaskInput,
    locale: SupportedLocale = 'en'
  ) {
    await assertProjectAccess(projectId, organizationId, userId, locale);
    validateTaskFields(input, true);

    const existing = await db
      .select({ id: scheduledTasks.id })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.projectId, projectId));
    if (existing.length >= MAX_TASKS_PER_PROJECT) {
      throw new HTTPException(400, {
        message: `A project can have at most ${MAX_TASKS_PER_PROJECT} scheduled tasks`,
      });
    }

    const timezone = input.timezone?.trim() || 'UTC';
    const schedule = input.schedule!.trim();

    const [task] = await db
      .insert(scheduledTasks)
      .values({
        projectId,
        name: input.name!.trim(),
        type: input.type!,
        schedule,
        timezone,
        command: input.type === 'command' ? input.command!.trim() : null,
        httpUrl: input.type === 'http' ? input.httpUrl!.trim() : null,
        timeoutSeconds: input.timeoutSeconds ?? 120,
        enabled: input.enabled ?? true,
        nextRunAt: nextCronRun(schedule, timezone),
      })
      .returning();

    logger.info({ taskId: task.id, projectId, userId }, 'Scheduled task created');
    return task;
  },

  async updateTask(
    projectId: string,
    taskId: string,
    organizationId: string,
    userId: string,
    input: ScheduledTaskInput,
    locale: SupportedLocale = 'en'
  ) {
    await assertProjectAccess(projectId, organizationId, userId, locale);
    const task = await this.getTask(projectId, taskId);
    validateTaskFields({ ...input, type: task.type }, false);

    const schedule = input.schedule?.trim() ?? task.schedule;
    const timezone = input.timezone?.trim() || task.timezone;
    if (input.schedule !== undefined || input.timezone !== undefined) {
      const error = validateCronExpression(schedule, timezone);
      if (error) throw new HTTPException(400, { message: error });
    }

    const [updated] = await db
      .update(scheduledTasks)
      .set({
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.command !== undefined && task.type === 'command'
          ? { command: input.command?.trim() ?? null }
          : {}),
        ...(input.httpUrl !== undefined && task.type === 'http'
          ? { httpUrl: input.httpUrl?.trim() ?? null }
          : {}),
        ...(input.timeoutSeconds !== undefined ? { timeoutSeconds: input.timeoutSeconds } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        schedule,
        timezone,
        // Recompute so a schedule/timezone change (or re-enable) takes effect immediately
        nextRunAt: nextCronRun(schedule, timezone),
        updatedAt: new Date(),
      })
      .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.projectId, projectId)))
      .returning();

    logger.info({ taskId, projectId, userId }, 'Scheduled task updated');
    return updated;
  },

  async deleteTask(
    projectId: string,
    taskId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en'
  ) {
    await assertProjectAccess(projectId, organizationId, userId, locale);
    await this.getTask(projectId, taskId);
    await db
      .delete(scheduledTasks)
      .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.projectId, projectId)));
    logger.info({ taskId, projectId, userId }, 'Scheduled task deleted');
  },

  async listRuns(
    projectId: string,
    taskId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale = 'en',
    limit = 20
  ) {
    await assertProjectAccess(projectId, organizationId, userId, locale);
    await this.getTask(projectId, taskId);
    return db
      .select()
      .from(scheduledTaskRuns)
      .where(eq(scheduledTaskRuns.taskId, taskId))
      .orderBy(desc(scheduledTaskRuns.startedAt))
      .limit(Math.min(limit, 100));
  },

  async getTask(projectId: string, taskId: string) {
    const [task] = await db
      .select()
      .from(scheduledTasks)
      .where(and(eq(scheduledTasks.id, taskId), eq(scheduledTasks.projectId, projectId)))
      .limit(1);
    if (!task) {
      throw new HTTPException(404, { message: 'Scheduled task not found' });
    }
    return task;
  },
};
