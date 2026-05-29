import { pgTable, uuid, timestamp, bigint, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';

/** Per-organization usage counters for the current UTC calendar month */
export const organizationMonthlyUsage = pgTable(
  'organization_monthly_usage',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** First instant of the UTC month (e.g. 2026-05-01T00:00:00Z) */
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    bandwidthBytes: bigint('bandwidth_bytes', { mode: 'number' }).default(0).notNull(),
    /** Peak observed storage (deploy images + artifacts) in bytes */
    storageBytesPeak: bigint('storage_bytes_peak', { mode: 'number' }).default(0).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    orgPeriodUnique: uniqueIndex('organization_monthly_usage_org_period_idx').on(
      table.organizationId,
      table.periodStart,
    ),
  }),
);

export const organizationMonthlyUsageRelations = relations(
  organizationMonthlyUsage,
  ({ one }) => ({
    organization: one(organizations, {
      fields: [organizationMonthlyUsage.organizationId],
      references: [organizations.id],
    }),
  }),
);
