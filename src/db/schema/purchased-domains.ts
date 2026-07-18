import {
  pgTable,
  uuid,
  integer,
  varchar,
  timestamp,
  text,
  boolean,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { projects } from './projects';

export const purchasedDomainStatusEnum = pgEnum('purchased_domain_status', [
  'active',
  'expired',
  'transfer_pending',
  'transfer_failed',
]);

/** Domains sold through Pushify via the registrar reseller integration. */
export const purchasedDomains = pgTable('purchased_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
  domainName: varchar('domain_name', { length: 255 }).notNull().unique(),
  registrar: varchar('registrar', { length: 32 }).notNull().default('namecom'),
  status: purchasedDomainStatusEnum('status').notNull().default('active'),
  years: integer('years').notNull().default(1),
  /** Retail price charged to the customer (USD cents) */
  purchasePriceCents: integer('purchase_price_cents').notNull(),
  /** Wholesale price paid to the registrar (USD cents) */
  wholesalePriceCents: integer('wholesale_price_cents').notNull(),
  /** Registrar's renewal price captured at purchase time (USD cents) */
  renewalWholesaleCents: integer('renewal_wholesale_cents'),
  autoRenew: boolean('auto_renew').notNull().default(true),
  registeredAt: timestamp('registered_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastRenewalError: text('last_renewal_error'),
  renewalReminderSentAt: timestamp('renewal_reminder_sent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const purchasedDomainsRelations = relations(purchasedDomains, ({ one }) => ({
  organization: one(organizations, {
    fields: [purchasedDomains.organizationId],
    references: [organizations.id],
  }),
  project: one(projects, {
    fields: [purchasedDomains.projectId],
    references: [projects.id],
  }),
}));
