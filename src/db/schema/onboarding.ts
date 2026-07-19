import { pgTable, uuid, varchar, timestamp, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { users } from './users';

/** Which lifecycle email an organization has already received (dedupe). */
export const onboardingEmails = pgTable(
  'onboarding_emails',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    emailKey: varchar('email_key', { length: 40 }).notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    orgEmailUnique: uniqueIndex('onboarding_emails_org_key_unique').on(t.organizationId, t.emailKey),
  })
);

/** One-question exit survey answered during subscription cancellation. */
export const cancellationFeedback = pgTable('cancellation_feedback', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
  reason: varchar('reason', { length: 40 }).notNull(),
  comment: text('comment'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
