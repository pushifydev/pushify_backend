import { pgTable, uuid, varchar, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { projects } from './projects';

// Persistent named Docker volumes for user apps: mounted as pushify-vol-<slug>-<name> at
// containerPath on every deploy (blue-green included), surviving container recreation.
export const projectVolumes = pgTable(
  'project_volumes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Volume name suffix — [a-z0-9-], shell-safe by validation */
    name: varchar('name', { length: 32 }).notNull(),
    /** Absolute mount path inside the container */
    containerPath: varchar('container_path', { length: 255 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    nameIdx: uniqueIndex('project_volumes_name_idx').on(table.projectId, table.name),
    pathIdx: uniqueIndex('project_volumes_path_idx').on(table.projectId, table.containerPath),
  })
);

export const projectVolumesRelations = relations(projectVolumes, ({ one }) => ({
  project: one(projects, {
    fields: [projectVolumes.projectId],
    references: [projects.id],
  }),
}));
