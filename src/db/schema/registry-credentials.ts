import { pgTable, uuid, varchar, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';

/**
 * Credentials for a private container registry, one per registry per organization. Used at
 * deploy time to `docker login` before a build (a private `FROM` base image) or a pull (a
 * project deployed from an image), into a config directory thrown away with the deploy.
 */
export const registryCredentials = pgTable(
  'registry_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** What the user called it, shown in the deploy log */
    name: varchar('name', { length: 100 }).notNull(),
    /** Host only, normalized: `ghcr.io`, `docker.io`, `registry.example.com:5000` */
    registry: varchar('registry', { length: 255 }).notNull(),
    username: varchar('username', { length: 255 }).notNull(),
    /** Password or access token, encrypted — never returned by the API */
    passwordEncrypted: text('password_encrypted').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgRegistry: uniqueIndex('registry_credentials_org_registry_idx').on(table.organizationId, table.registry),
  })
);

export const registryCredentialsRelations = relations(registryCredentials, ({ one }) => ({
  organization: one(organizations, {
    fields: [registryCredentials.organizationId],
    references: [organizations.id],
  }),
}));
