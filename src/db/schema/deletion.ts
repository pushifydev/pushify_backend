import { pgTable, uuid, varchar, timestamp, jsonb, integer, text, primaryKey } from 'drizzle-orm/pg-core';

/**
 * What is kept after an organization is purged: invoice and payment facts only, until
 * `retainUntil` (the legal retention period). No foreign keys — the organization is gone.
 */
export const deletedOrganizations = pgTable('deleted_organizations', {
  id: uuid('id').primaryKey(), // the former organizations.id
  name: varchar('name', { length: 255 }).notNull(),
  billingEmail: varchar('billing_email', { length: 255 }),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  walletLedger: jsonb('wallet_ledger').$type<unknown[]>().default([]).notNull(),
  deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }).notNull(),
  purgedAt: timestamp('purged_at', { withTimezone: true }).defaultNow().notNull(),
  retainUntil: timestamp('retain_until', { withTimezone: true }).notNull(),
});

/** Progress of a purge, one row per step, so a failed step is retried without redoing the rest. */
export const deletionPurgeSteps = pgTable(
  'deletion_purge_steps',
  {
    organizationId: uuid('organization_id').notNull(),
    step: varchar('step', { length: 64 }).notNull(),
    status: varchar('status', { length: 16 }).notNull(), // pending | done | failed
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({ pk: primaryKey({ name: 'deletion_purge_steps_pk', columns: [t.organizationId, t.step] }) }),
);
