import { pgTable, uuid, varchar, timestamp, boolean, text, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { projects } from './projects';
import { deployments } from './deployments';

// Enums
export const notificationChannelTypeEnum = pgEnum('notification_channel_type', ['slack', 'email', 'webhook']);
export const notificationStatusEnum = pgEnum('notification_status', ['sent', 'failed']);

// Notification events that can trigger a notification
export const notificationEventEnum = pgEnum('notification_event', [
  'deployment.started',
  'deployment.success',
  'deployment.failed',
  'health.unhealthy',
  'health.recovered',
]);

// Notification channels per project
export const notificationChannels = pgTable('notification_channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  type: notificationChannelTypeEnum('type').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  configEncrypted: text('config_encrypted').notNull(), // Encrypted JSON config (webhook URL, email addresses, etc.)
  events: text('events').array().default([]).notNull(), // Array of event types to notify on
  isActive: boolean('is_active').default(true).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Notification delivery logs
export const notificationLogs = pgTable('notification_logs', {
  id: uuid('id').primaryKey().defaultRandom(),
  channelId: uuid('channel_id')
    .notNull()
    .references(() => notificationChannels.id, { onDelete: 'cascade' }),
  deploymentId: uuid('deployment_id')
    .references(() => deployments.id, { onDelete: 'set null' }),
  eventType: varchar('event_type', { length: 100 }).notNull(),
  status: notificationStatusEnum('status').notNull(),
  errorMessage: text('error_message'),
  sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const notificationChannelsRelations = relations(notificationChannels, ({ one, many }) => ({
  project: one(projects, {
    fields: [notificationChannels.projectId],
    references: [projects.id],
  }),
  logs: many(notificationLogs),
}));

export const notificationLogsRelations = relations(notificationLogs, ({ one }) => ({
  channel: one(notificationChannels, {
    fields: [notificationLogs.channelId],
    references: [notificationChannels.id],
  }),
  deployment: one(deployments, {
    fields: [notificationLogs.deploymentId],
    references: [deployments.id],
  }),
}));

// Types
export type NotificationChannel = typeof notificationChannels.$inferSelect;
export type NewNotificationChannel = typeof notificationChannels.$inferInsert;
export type NotificationLog = typeof notificationLogs.$inferSelect;
export type NewNotificationLog = typeof notificationLogs.$inferInsert;
