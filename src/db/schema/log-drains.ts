import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { projects } from './projects';

/**
 * Where a log agent on the organization's servers sends container logs and metrics (HTTP, Grafana
 * Loki, Datadog, Elasticsearch or S3). Organization-wide when `project_id` is null, or for one
 * project. The credential is write-only: encrypted here, never returned by the API, and only
 * decrypted to write the agent's configuration on the server (lib/log-drains.ts).
 */
export const logDrains = pgTable(
  'log_drains',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 100 }).notNull(),
    /** `http` | `loki` | `datadog` | `elastic` | `s3` (LOG_DRAIN_TYPES) */
    type: varchar('type', { length: 20 }).notNull(),
    /** URL for http / loki / elastic; optional S3-compatible endpoint for s3; null for datadog */
    endpoint: varchar('endpoint', { length: 500 }),
    /** Non-secret settings per type (LogDrainOptions): username, site, index, bucket, region, prefix, accessKeyId */
    options: jsonb('options').$type<Record<string, string>>().default({}).notNull(),
    /** Token / API key / password / S3 secret key, encrypted — never returned by the API */
    secretEncrypted: text('secret_encrypted'),
    sendLogs: boolean('send_logs').default(true).notNull(),
    sendMetrics: boolean('send_metrics').default(false).notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    lastTestedAt: timestamp('last_tested_at', { withTimezone: true }),
    lastTestOk: boolean('last_test_ok'),
    lastTestError: varchar('last_test_error', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('log_drains_org_idx').on(table.organizationId),
  })
);

export const logDrainsRelations = relations(logDrains, ({ one }) => ({
  organization: one(organizations, {
    fields: [logDrains.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [logDrains.projectId],
    references: [projects.id],
  }),
}));

export type LogDrain = typeof logDrains.$inferSelect;
export type NewLogDrain = typeof logDrains.$inferInsert;
