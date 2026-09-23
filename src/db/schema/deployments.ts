import { pgTable, uuid, varchar, timestamp, text, pgEnum, boolean, integer } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { projects } from './projects';
import { users } from './users';

// Enums
export const deploymentStatusEnum = pgEnum('deployment_status', [
  'pending',
  'building',
  'deploying',
  'running',
  'failed',
  'stopped',
  'cancelled',
]);

export const deploymentTriggerEnum = pgEnum('deployment_trigger', [
  'manual',
  'git_push',
  'rollback',
  'redeploy',
]);

export const deployments = pgTable('deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),

  // Status
  status: deploymentStatusEnum('status').default('pending').notNull(),
  trigger: deploymentTriggerEnum('trigger').default('manual').notNull(),

  // Git info
  commitHash: varchar('commit_hash', { length: 40 }),
  commitMessage: text('commit_message'),
  branch: varchar('branch', { length: 100 }),

  // Docker image info (for quick rollback without rebuild)
  dockerImageId: varchar('docker_image_id', { length: 100 }), // Docker image digest/ID

  /**
   * How this deployment's container was started — image, port, env, volumes, network, limits.
   * Encrypted, because the environment variables are in it.
   *
   * Autoscaling needs to start a container identical to the ones the deploy started, between
   * deploys. Rebuilding those arguments from project settings afterwards would drift: a variable
   * added since, a volume removed, and the new replica quietly differs from its siblings. The
   * deploy records what it actually used instead.
   */
  runSpecEncrypted: text('run_spec_encrypted'),
  containerPort: integer('container_port'), // Port the container is running on

  // Rollback reference - stores the deployment ID we're rolling back to
  rollbackFromDeploymentId: uuid('rollback_from_deployment_id'),

  // Logs (stored as text, in production would use object storage)
  buildLogs: text('build_logs'),
  deployLogs: text('deploy_logs'),

  // Error info
  errorMessage: text('error_message'),

  // Timestamps
  buildStartedAt: timestamp('build_started_at', { withTimezone: true }),
  buildFinishedAt: timestamp('build_finished_at', { withTimezone: true }),
  deployStartedAt: timestamp('deploy_started_at', { withTimezone: true }),
  deployFinishedAt: timestamp('deploy_finished_at', { withTimezone: true }),

  // Preview deployment info
  /** production | staging (previews keep isPreview) */
  environment: varchar('environment', { length: 20 }).default('production').notNull(),
  /** Set when this production deploy is the staging deployment it names, built from its commit */
  promotedFromDeploymentId: uuid('promoted_from_deployment_id'),
  isPreview: boolean('is_preview').default(false).notNull(),
  previewPrNumber: integer('preview_pr_number'),

  // Metadata
  triggeredById: uuid('triggered_by_id').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const deploymentsRelations = relations(deployments, ({ one }) => ({
  project: one(projects, {
    fields: [deployments.projectId],
    references: [projects.id],
  }),
  triggeredBy: one(users, {
    fields: [deployments.triggeredById],
    references: [users.id],
  }),
}));
