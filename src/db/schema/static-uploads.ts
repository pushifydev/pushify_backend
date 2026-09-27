import { pgTable, uuid, timestamp, integer, customType, index } from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { deployments } from './deployments';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Uploaded static sites ("drop a folder, get a URL"). Each upload is one version: the validated
 * files, packed as a zip, so a redeploy or a rollback republishes exactly what was uploaded.
 * Only the most recent few versions per project are kept.
 */
export const staticUploads = pgTable(
  'static_uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    deploymentId: uuid('deployment_id').references(() => deployments.id, { onDelete: 'set null' }),
    archive: bytea('archive').notNull(),
    fileCount: integer('file_count').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectCreatedIdx: index('static_uploads_project_created_idx').on(table.projectId, table.createdAt),
  }),
);

export type StaticUpload = typeof staticUploads.$inferSelect;
