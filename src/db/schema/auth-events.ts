import { pgTable, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users';

/**
 * Sign-in history. Sessions are deleted on logout and expiry, so without this table there is
 * no record that a login ever happened. One row per attempt — failures are kept so an operator
 * can spot a brute-force run or a user stuck at the second factor.
 *
 * Plain varchar rather than a pg enum: the set grows as auth flows are added and an audit table
 * that only our code writes to gains nothing from a database-level check.
 */
export const AUTH_EVENT_TYPES = [
  'register',
  'login',
  'login_failed',
  'two_factor_required',
  'two_factor_failed',
] as const;
export type AuthEventType = (typeof AUTH_EVENT_TYPES)[number];

export const AUTH_METHODS = ['password', 'two_factor', 'github', 'google', 'sso'] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const authEvents = pgTable(
  'auth_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    event: varchar('event', { length: 32 }).$type<AuthEventType>().notNull(),
    method: varchar('method', { length: 16 }).$type<AuthMethod>().notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    userCreatedIdx: index('auth_events_user_created_idx').on(t.userId, t.createdAt),
    createdIdx: index('auth_events_created_idx').on(t.createdAt),
  })
);

/** Every request that passes the platform-admin gate — who looked at what, and when. */
export const adminAuditLogs = pgTable(
  'admin_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    adminUserId: uuid('admin_user_id').references(() => users.id, { onDelete: 'set null' }),
    method: varchar('method', { length: 8 }).notNull(),
    path: varchar('path', { length: 500 }).notNull(),
    ipAddress: varchar('ip_address', { length: 45 }),
    userAgent: varchar('user_agent', { length: 500 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    createdIdx: index('admin_audit_logs_created_idx').on(t.createdAt),
  })
);
