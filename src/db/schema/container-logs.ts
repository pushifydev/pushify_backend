import { pgTable, uuid, varchar, timestamp, text, integer, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { deployments } from './deployments';
import { projects } from './projects';

/**
 * Container Logs Table
 * Stores runtime logs from deployed containers
 * Logs are collected periodically and stored for persistence
 */
export const containerLogs = pgTable(
  'container_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    deploymentId: uuid('deployment_id')
      .notNull()
      .references(() => deployments.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),

    // Log content (stored in chunks to handle large volumes)
    logContent: text('log_content').notNull(),

    // Log metadata
    logType: varchar('log_type', { length: 20 }).default('stdout').notNull(), // stdout, stderr
    lineCount: integer('line_count').default(0).notNull(),

    // Timestamp range for this chunk
    startTimestamp: timestamp('start_timestamp', { withTimezone: true }),
    endTimestamp: timestamp('end_timestamp', { withTimezone: true }),

    // Chunk index for ordering
    chunkIndex: integer('chunk_index').default(0).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    // Index for efficient querying by deployment
    deploymentIdx: index('container_logs_deployment_idx').on(table.deploymentId),
    // Index for querying by project
    projectIdx: index('container_logs_project_idx').on(table.projectId),
    // Index for time-based queries
    timeIdx: index('container_logs_time_idx').on(table.deploymentId, table.chunkIndex),
  })
);

// Relations
export const containerLogsRelations = relations(containerLogs, ({ one }) => ({
  deployment: one(deployments, {
    fields: [containerLogs.deploymentId],
    references: [deployments.id],
  }),
  project: one(projects, {
    fields: [containerLogs.projectId],
    references: [projects.id],
  }),
}));

// Type exports
export type ContainerLog = typeof containerLogs.$inferSelect;
export type NewContainerLog = typeof containerLogs.$inferInsert;
