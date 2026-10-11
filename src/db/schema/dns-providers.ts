import { pgTable, uuid, varchar, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';

/**
 * An organization's DNS provider credential (Cloudflare for now). When present, adding a custom
 * domain to an app also creates its A/AAAA record in the matching zone. The API token is
 * write-only: stored encrypted, never returned by the API and never logged unmasked.
 */
export const dnsProviderConnections = pgTable(
  'dns_provider_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** `cloudflare` */
    provider: varchar('provider', { length: 30 }).notNull(),
    /** API token, encrypted (lib/encryption) */
    apiTokenEncrypted: text('api_token_encrypted').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgProviderIdx: uniqueIndex('dns_provider_connections_org_provider_idx').on(table.organizationId, table.provider),
  })
);

export const dnsProviderConnectionsRelations = relations(dnsProviderConnections, ({ one }) => ({
  organization: one(organizations, {
    fields: [dnsProviderConnections.organizationId],
    references: [organizations.id],
  }),
}));

export type DnsProviderConnection = typeof dnsProviderConnections.$inferSelect;
