import { pgTable, uuid, varchar, timestamp, text, pgEnum, bigint } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { organizations } from './organizations';

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


/**
 * A GitHub App installation: one account (user or organisation) that installed Pushify on some
 * or all of its repositories.
 *
 * This row is the durable credential — access tokens are minted from it on demand and never
 * stored. Unlike the OAuth model it replaces, it is not tied to the person who created it.
 */
export const githubAppInstallations = pgTable('github_app_installations', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** GitHub's numeric installation id */
  installationId: bigint('installation_id', { mode: 'number' }).notNull().unique(),
  accountLogin: varchar('account_login', { length: 255 }).notNull(),
  accountId: bigint('account_id', { mode: 'number' }),
  /** 'User' or 'Organization', as GitHub reports it */
  accountType: varchar('account_type', { length: 32 }),
  /** 'all' or 'selected' */
  repositorySelection: varchar('repository_selection', { length: 16 }),

  /** The Pushify organisation this installation serves; null until someone claims it. */
  organizationId: uuid('organization_id').references(() => organizations.id, {
    onDelete: 'cascade',
  }),
  installedByUserId: uuid('installed_by_user_id').references(() => users.id, {
    onDelete: 'set null',
  }),

  /** Set while GitHub reports the installation as suspended; deploys must not use it. */
  suspendedAt: timestamp('suspended_at', { withTimezone: true }),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type GithubAppInstallation = typeof githubAppInstallations.$inferSelect;
export type NewGithubAppInstallation = typeof githubAppInstallations.$inferInsert;
