import { pgTable, uuid, varchar, timestamp, text, boolean } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { organizations } from './organizations';

/**
 * API Keys for programmatic access
 * - Keys are hashed before storage (only shown once on creation)
 * - Prefix is stored for identification (e.g., "pk_live_abc...")
 */
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').defaultRandom().primaryKey(),

  // Ownership
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),

  // Key identification
  name: varchar('name', { length: 255 }).notNull(),
  prefix: varchar('prefix', { length: 12 }).notNull(), // "pk_live_xxx" for display
  keyHash: varchar('key_hash', { length: 64 }).notNull(), // SHA-256 hash

  // Permissions - stored as comma-separated scopes
  // e.g., "deployments:read,deployments:write,projects:read"
  scopes: text('scopes').notNull().default('*'), // '*' means all permissions

  // Status
  isActive: boolean('is_active').notNull().default(true),

  // Timestamps
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
});

// Relations
export const apiKeysRelations = relations(apiKeys, ({ one }) => ({
  user: one(users, {
    fields: [apiKeys.userId],
    references: [users.id],
  }),
  organization: one(organizations, {
    fields: [apiKeys.organizationId],
    references: [organizations.id],
  }),
}));

export type ApiKey = typeof apiKeys.$inferSelect;
export type NewApiKey = typeof apiKeys.$inferInsert;

// Scopes definition
export const API_KEY_SCOPES = {
  // Projects
  'projects:read': 'Read project information',
  'projects:write': 'Create and update projects',
  'projects:delete': 'Delete projects',

  // Deployments
  'deployments:read': 'Read deployment information',
  'deployments:write': 'Create deployments (trigger deploys)',
  'deployments:cancel': 'Cancel running deployments',

  // Environment Variables
  'envvars:read': 'Read environment variables',
  'envvars:write': 'Create and update environment variables',

  // Domains
  'domains:read': 'Read domain information',
  'domains:write': 'Add and remove domains',

  // Logs
  'logs:read': 'Read deployment and container logs',

  // Metrics
  'metrics:read': 'Read container metrics',
} as const;

export type ApiKeyScope = keyof typeof API_KEY_SCOPES;
