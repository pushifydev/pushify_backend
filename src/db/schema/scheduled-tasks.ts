import { pgTable, uuid, varchar, timestamp, boolean, integer, text, pgEnum, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { projects } from './projects';

// Enums
export const scheduledTaskTypeEnum = pgEnum('scheduled_task_type', ['command', 'http']);
export const scheduledTaskRunStatusEnum = pgEnum('scheduled_task_run_status', [
  'success',
  'failed',
  'timeout',
]);

// User-defined cron jobs per project: run a command inside the app container (over SSH on the
// project's server/runner) or hit an HTTP endpoint, on a cron schedule.
export const scheduledTasks = pgTable(
  'scheduled_tasks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    type: scheduledTaskTypeEnum('type').notNull(),
    /** 5-field cron expression (minute granularity) */
    schedule: varchar('schedule', { length: 100 }).notNull(),
    /** IANA timezone the schedule is evaluated in */
    timezone: varchar('timezone', { length: 64 }).default('UTC').notNull(),
    /** command type: shell command executed inside the app container */
    command: text('command'),
    /** http type: URL to GET */
    httpUrl: varchar('http_url', { length: 1000 }),
    timeoutSeconds: integer('timeout_seconds').default(120).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: scheduledTaskRunStatusEnum('last_status'),
    /** Precomputed next fire time — the worker claims rows where this is due */
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    dueIdx: index('scheduled_tasks_due_idx').on(table.enabled, table.nextRunAt),
    projectIdx: index('scheduled_tasks_project_idx').on(table.projectId),
  })
);

// Run history (pruned after a retention window)
export const scheduledTaskRuns = pgTable(
  'scheduled_task_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    taskId: uuid('task_id')
      .notNull()
      .references(() => scheduledTasks.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    status: scheduledTaskRunStatusEnum('status').notNull(),
    /** schedule | manual */
    trigger: varchar('trigger', { length: 20 }).default('schedule').notNull(),
    exitCode: integer('exit_code'),
    httpStatus: integer('http_status'),
    /** Combined stdout/stderr or response snippet, truncated */
    output: text('output'),
    errorMessage: varchar('error_message', { length: 500 }),
    durationMs: integer('duration_ms'),
    startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => ({
    taskIdx: index('scheduled_task_runs_task_idx').on(table.taskId, table.startedAt),
  })
);

// Relations
export const scheduledTasksRelations = relations(scheduledTasks, ({ one, many }) => ({
  project: one(projects, {
    fields: [scheduledTasks.projectId],
    references: [projects.id],
  }),
  runs: many(scheduledTaskRuns),
}));

export const scheduledTaskRunsRelations = relations(scheduledTaskRuns, ({ one }) => ({
  task: one(scheduledTasks, {
    fields: [scheduledTaskRuns.taskId],
    references: [scheduledTasks.id],
  }),
}));
