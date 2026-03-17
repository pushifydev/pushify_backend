import { pgTable, uuid, varchar, timestamp, boolean, integer, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { projects } from './projects';
import { deployments } from './deployments';

// Enums
export const healthCheckStatusEnum = pgEnum('health_check_status', ['healthy', 'unhealthy', 'timeout', 'unknown']);

// Health check configuration per project
export const healthChecks = pgTable('health_checks', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .unique()
    .references(() => projects.id, { onDelete: 'cascade' }),
  endpoint: varchar('endpoint', { length: 500 }).default('/health').notNull(),
  intervalSeconds: integer('interval_seconds').default(30).notNull(),
  timeoutSeconds: integer('timeout_seconds').default(10).notNull(),
  unhealthyThreshold: integer('unhealthy_threshold').default(3).notNull(),
  autoRestart: boolean('auto_restart').default(true).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Health check results/logs
export const healthCheckLogs = pgTable('health_check_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  deploymentId: uuid('deployment_id')
    .references(() => deployments.id, { onDelete: 'set null' }),
  status: healthCheckStatusEnum('status').notNull(),
  responseTimeMs: integer('response_time_ms'),
  statusCode: integer('status_code'),
  consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
  actionTaken: varchar('action_taken', { length: 50 }), // 'none' | 'restarted' | 'notified'
  errorMessage: varchar('error_message', { length: 500 }),
  checkedAt: timestamp('checked_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const healthChecksRelations = relations(healthChecks, ({ one }) => ({
  project: one(projects, {
    fields: [healthChecks.projectId],
    references: [projects.id],
  }),
}));

export const healthCheckLogsRelations = relations(healthCheckLogs, ({ one }) => ({
  project: one(projects, {
    fields: [healthCheckLogs.projectId],
    references: [projects.id],
  }),
  deployment: one(deployments, {
    fields: [healthCheckLogs.deploymentId],
    references: [deployments.id],
  }),
}));

// Types
export type HealthCheck = typeof healthChecks.$inferSelect;
export type NewHealthCheck = typeof healthChecks.$inferInsert;
export type HealthCheckLog = typeof healthCheckLogs.$inferSelect;
export type NewHealthCheckLog = typeof healthCheckLogs.$inferInsert;
