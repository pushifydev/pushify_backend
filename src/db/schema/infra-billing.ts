import {
  pgTable,
  uuid,
  integer,
  varchar,
  timestamp,
  text,
  jsonb,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
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

/**
 * Included server credit grants. One `period` row per organization and period and one
 * `upgrade` row per period and target plan (partial unique indexes, migration 0061) make a
 * double grant impossible; `expire` rows record credit removed on cancellation or refund.
 */
export const includedCreditGrants = pgTable(
  'included_credit_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    periodKey: varchar('period_key', { length: 10 }).notNull(),
    kind: varchar('kind', { length: 16 }).$type<'period' | 'upgrade' | 'expire'>().notNull(),
    plan: varchar('plan', { length: 16 }).notNull(),
    /** Positive for grants, negative for expiries */
    amountCents: integer('amount_cents').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    periodUq: uniqueIndex('included_credit_grants_period_uq')
      .on(t.organizationId, t.periodKey)
      .where(sql`${t.kind} = 'period'`),
    upgradeUq: uniqueIndex('included_credit_grants_upgrade_uq')
      .on(t.organizationId, t.periodKey, t.plan)
      .where(sql`${t.kind} = 'upgrade'`),
    orgPeriodIdx: index('included_credit_grants_org_period_idx').on(t.organizationId, t.periodKey),
  }),
);
