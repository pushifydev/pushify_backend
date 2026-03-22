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
  configuration: jsonb('configuration').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
