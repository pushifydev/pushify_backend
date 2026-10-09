import { pgTable, uuid, varchar, text, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { projects } from './projects';

/**
 * A connection to an external secret manager (Infisical for now). Organization-wide when
 * `project_id` is null, or for one project — a project connection wins over the organization's.
 * Env values reference it as `{{infisical.KEY}}`; the secrets themselves are fetched at deploy
 * time and never stored here or anywhere else in the database.
 */
export const secretProviderConnections = pgTable(
  'secret_provider_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** `infisical` */
    provider: varchar('provider', { length: 30 }).notNull(),
    siteUrl: varchar('site_url', { length: 500 }).notNull(),
    /** Machine identity (Universal Auth) client id */
    clientId: varchar('client_id', { length: 255 }).notNull(),
    /** Machine identity client secret, encrypted — never returned by the API */
    clientSecretEncrypted: text('client_secret_encrypted').notNull(),
    /** Infisical project (workspace) id */
    workspaceId: varchar('workspace_id', { length: 255 }).notNull(),
    environment: varchar('environment', { length: 64 }).notNull(),
    secretPath: varchar('secret_path', { length: 500 }).default('/').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgIdx: index('secret_provider_connections_org_idx').on(table.organizationId),
  })
);

export const secretProviderConnectionsRelations = relations(secretProviderConnections, ({ one }) => ({
  organization: one(organizations, {
    fields: [secretProviderConnections.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [secretProviderConnections.projectId],
    references: [projects.id],
  }),
}));
