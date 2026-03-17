import { pgTable, uuid, varchar, timestamp, text, pgEnum } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';

// Git provider enum
export const gitProviderEnum = pgEnum('git_provider', ['github', 'gitlab', 'bitbucket']);

// User Git integrations (OAuth connections)
export const gitIntegrations = pgTable('git_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  provider: gitProviderEnum('provider').notNull(),
  providerAccountId: varchar('provider_account_id', { length: 255 }).notNull(),
  providerUsername: varchar('provider_username', { length: 255 }),
  accessToken: text('access_token').notNull(), // Encrypted
  refreshToken: text('refresh_token'), // Encrypted, if applicable
  tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
  scopes: text('scopes'), // JSON array of granted scopes
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const gitIntegrationsRelations = relations(gitIntegrations, ({ one }) => ({
  user: one(users, {
    fields: [gitIntegrations.userId],
    references: [users.id],
  }),
}));

// Types
export type GitIntegration = typeof gitIntegrations.$inferSelect;
export type NewGitIntegration = typeof gitIntegrations.$inferInsert;
