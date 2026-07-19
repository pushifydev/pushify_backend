import {
  pgTable,
  uuid,
  integer,
  varchar,
  timestamp,
  text,
  jsonb,
  pgEnum,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { servers } from './servers';

export const infraWalletTransactionTypeEnum = pgEnum('infra_wallet_transaction_type', [
  'credit_topup',
  'server_hourly_charge',
  'server_refund',
  'adjustment',
  'domain_purchase',
  'domain_renewal',
]);

export const infraWalletTransactions = pgTable('infra_wallet_transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  serverId: uuid('server_id').references(() => servers.id, { onDelete: 'set null' }),
  type: infraWalletTransactionTypeEnum('type').notNull(),
  /** Signed amount in USD cents (credits positive, charges negative) */
  amountCents: integer('amount_cents').notNull(),
  balanceAfterCents: integer('balance_after_cents').notNull(),
  description: text('description'),
  metadata: jsonb('metadata').default({}).notNull(),
  stripeCheckoutSessionId: varchar('stripe_checkout_session_id', { length: 255 }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const infraWalletTransactionsRelations = relations(infraWalletTransactions, ({ one }) => ({
  organization: one(organizations, {
    fields: [infraWalletTransactions.organizationId],
    references: [organizations.id],
  }),
  server: one(servers, {
    fields: [infraWalletTransactions.serverId],
    references: [servers.id],
  }),
}));
