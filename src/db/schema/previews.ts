import { pgTable, uuid, varchar, timestamp, integer, bigint, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { projects } from './projects';
import { deployments } from './deployments';

// Enums
export const previewStatusEnum = pgEnum('preview_status', [
  'pending',
  'building',
  'running',
  'stopped',
  'failed',
]);

// Preview deployments (one per PR)
export const previewDeployments = pgTable('preview_deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  deploymentId: uuid('deployment_id')
    .references(() => deployments.id, { onDelete: 'set null' }),

  // PR info
  prNumber: integer('pr_number').notNull(),
  prTitle: varchar('pr_title', { length: 500 }),
  prBranch: varchar('pr_branch', { length: 255 }).notNull(),
  baseBranch: varchar('base_branch', { length: 255 }).notNull(),

  // Preview environment
  previewUrl: varchar('preview_url', { length: 500 }),
  containerName: varchar('container_name', { length: 255 }),
  hostPort: integer('host_port'),

  // GitHub integration
  githubCommentId: bigint('github_comment_id', { mode: 'number' }),

  // Status
  status: previewStatusEnum('status').default('pending').notNull(),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

// Relations
export const previewDeploymentsRelations = relations(previewDeployments, ({ one }) => ({
  project: one(projects, {
    fields: [previewDeployments.projectId],
    references: [projects.id],
  }),
  deployment: one(deployments, {
    fields: [previewDeployments.deploymentId],
    references: [deployments.id],
  }),
}));

// Types
export type PreviewDeployment = typeof previewDeployments.$inferSelect;
export type NewPreviewDeployment = typeof previewDeployments.$inferInsert;
