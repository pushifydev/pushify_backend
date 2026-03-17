import { pgTable, uuid, varchar, timestamp, text, jsonb, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { organizations } from './organizations';
import { projects } from './projects';

// Activity action types
export const activityActionEnum = pgEnum('activity_action', [
  // Project actions
  'project.created',
  'project.updated',
  'project.deleted',
  'project.paused',
  'project.resumed',
  // Deployment actions
  'deployment.created',
  'deployment.cancelled',
  'deployment.redeployed',
  'deployment.rolledback',
  'deployment.succeeded',
  'deployment.failed',
  // Environment variable actions
  'envvar.created',
  'envvar.updated',
  'envvar.deleted',
  // Domain actions
  'domain.added',
  'domain.removed',
  'domain.verified',
  'domain.set_primary',
  'domain.nginx_updated',
  // API Key actions
  'apikey.created',
  'apikey.revoked',
  // Team actions
  'member.invited',
  'member.removed',
  'member.role_changed',
  // Settings actions
  'settings.updated',
  'webhook.regenerated',
  // Notification actions
  'notification.channel_created',
  'notification.channel_updated',
  'notification.channel_deleted',
  // Health check actions
  'healthcheck.enabled',
  'healthcheck.disabled',
  'healthcheck.updated',
]);

export type ActivityAction = typeof activityActionEnum.enumValues[number];

// Activity logs table
export const activityLogs = pgTable('activity_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .references(() => users.id, { onDelete: 'set null' }),
  projectId: uuid('project_id')
    .references(() => projects.id, { onDelete: 'set null' }),

  // Action info
  action: activityActionEnum('action').notNull(),
  description: text('description').notNull(),

  // Additional metadata (JSON)
  metadata: jsonb('metadata').default({}).notNull(),

  // IP and user agent for audit
  ipAddress: varchar('ip_address', { length: 45 }),
  userAgent: varchar('user_agent', { length: 500 }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const activityLogsRelations = relations(activityLogs, ({ one }) => ({
  organization: one(organizations, {
    fields: [activityLogs.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [activityLogs.userId],
    references: [users.id],
  }),
  project: one(projects, {
    fields: [activityLogs.projectId],
    references: [projects.id],
  }),
}));

// Type exports
export type ActivityLog = typeof activityLogs.$inferSelect;
export type NewActivityLog = typeof activityLogs.$inferInsert;
