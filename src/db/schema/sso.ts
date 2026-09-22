import { pgTable, uuid, varchar, text, timestamp, boolean, jsonb, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';

/**
 * Single sign-on for an organization, over OpenID Connect.
 *
 * One connection per organization: two would make "which provider signs this person in" a
 * question with no answer. `email_domains` decides whose sign-in goes to the provider, and is
 * also checked against the token the provider returns — a provider may only vouch for addresses
 * in the domains the organization claimed.
 */
export const ssoConnections = pgTable(
  'sso_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** The provider's issuer URL, exactly as it appears in the token's `iss` */
    issuer: varchar('issuer', { length: 500 }).notNull(),
    clientId: varchar('client_id', { length: 255 }).notNull(),
    /** Encrypted; never returned by the API */
    clientSecretEncrypted: text('client_secret_encrypted').notNull(),
    /** Lower-case domains, without the `@` */
    emailDomains: jsonb('email_domains').$type<string[]>().default([]).notNull(),
    /** Members in those domains may only sign in through the provider */
    enforced: boolean('enforced').default(false).notNull(),
    /** The role someone gets when the provider sends them for the first time */
    defaultRole: varchar('default_role', { length: 20 }).default('member').notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    onePerOrganization: uniqueIndex('sso_connections_organization_idx').on(table.organizationId),
  })
);

export const ssoConnectionsRelations = relations(ssoConnections, ({ one }) => ({
  organization: one(organizations, {
    fields: [ssoConnections.organizationId],
    references: [organizations.id],
  }),
}));
