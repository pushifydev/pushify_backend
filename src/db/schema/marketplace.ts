import { pgTable, uuid, varchar, timestamp, jsonb } from 'drizzle-orm/pg-core';
import { projects } from './projects';

export const marketplaceDeployments = pgTable('marketplace_deployments', {
  id: uuid('id').primaryKey().defaultRandom(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  templateId: varchar('template_id', { length: 100 }).notNull(),
  templateVersion: varchar('template_version', { length: 50 }).notNull(),
  appVersion: varchar('app_version', { length: 50 }).notNull(),
  // The env var names the app was deployed with, never their values: those are encrypted in
  // environment_variables (migration 0080 reduced older plain-text rows to their key names).
  configuration: jsonb('configuration').$type<string[]>().default([]).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
