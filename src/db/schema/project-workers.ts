import { pgTable, uuid, varchar, text, boolean, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { projects } from './projects';

/**
 * Worker processes: extra always-on containers started from the project's built
 * image with a different start command (queue consumers, schedulers, etc.).
 * They share the app's env vars and volumes but get no port/nginx wiring.
 */
export const projectWorkers = pgTable(
  'project_workers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 40 }).notNull(),
    command: text('command').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    nameIdx: uniqueIndex('project_workers_name_idx').on(table.projectId, table.name),
  })
);

export const projectWorkersRelations = relations(projectWorkers, ({ one }) => ({
  project: one(projects, {
    fields: [projectWorkers.projectId],
    references: [projects.id],
  }),
}));
