import { pgTable, uuid, varchar, timestamp, jsonb, pgEnum, text, integer, boolean, uniqueIndex } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { users } from './users';
import { projects } from './projects';

// Enums
export const memberRoleEnum = pgEnum('member_role', ['owner', 'admin', 'member', 'viewer']);
export const planTypeEnum = pgEnum('plan_type', ['free', 'hobby', 'pro', 'business', 'enterprise']);
export const billingStatusEnum = pgEnum('billing_status', ['active', 'past_due', 'suspended']);
export const invitationStatusEnum = pgEnum('invitation_status', ['pending', 'accepted', 'revoked']);

export type BillingStatus = 'active' | 'past_due' | 'suspended';

export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: varchar('name', { length: 255 }).notNull(),
  slug: varchar('slug', { length: 100 }).notNull().unique(),
  plan: planTypeEnum('plan').default('free').notNull(),
  billingEmail: varchar('billing_email', { length: 255 }),
  stripeCustomerId: varchar('stripe_customer_id', { length: 255 }),
  stripeSubscriptionId: varchar('stripe_subscription_id', { length: 255 }),
  stripeCurrentPeriodEnd: timestamp('stripe_current_period_end', { withTimezone: true }),
  /** Platform subscription payment state (Stripe retries = past_due; canceled = suspended) */
  billingStatus: billingStatusEnum('billing_status').default('active').notNull(),
  billingPaymentFailedNotifiedAt: timestamp('billing_payment_failed_notified_at', { withTimezone: true }),
  /** Prepaid USD cents for managed cloud infrastructure (Hetzner, etc.) */
  infraWalletBalanceCents: integer('infra_wallet_balance_cents').default(0).notNull(),
  /** Until this time, legacy (more generous) plan limits apply for paid tiers */
  grandfatheredUntil: timestamp('grandfathered_until', { withTimezone: true }),
  /** Optional per-limit overrides merged on top of effective plan limits */
  planLimitsOverride: jsonb('plan_limits_override').$type<Partial<Record<string, number | boolean>>>(),
  settings: jsonb('settings').default({}).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const studioAccessEnum = pgEnum('studio_access', ['none', 'read', 'write']);

export const organizationMembers = pgTable('organization_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: memberRoleEnum('role').default('member').notNull(),
  /** When true (member/viewer only), project access is limited to rows in member_project_access */
  restrictedAccess: boolean('restricted_access').default(false).notNull(),
  /**
   * Data-browser permission for members and viewers. Owners and admins always have write; this
   * column is what lets a team give a developer read access to real data without handing over
   * the ability to change it.
   */
  studioAccess: studioAccessEnum('studio_access').default('none').notNull(),
  invitedBy: uuid('invited_by').references(() => users.id),
  joinedAt: timestamp('joined_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Per-member project allowlist; only consulted when the member row has restricted_access = true */
export const memberProjectAccess = pgTable(
  'member_project_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    memberProjectIdx: uniqueIndex('member_project_access_unique_idx').on(
      table.organizationId,
      table.userId,
      table.projectId
    ),
  })
);

export const organizationInvitations = pgTable('organization_invitations', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  email: varchar('email', { length: 255 }).notNull(),
  role: memberRoleEnum('role').default('member').notNull(),
  invitedByUserId: uuid('invited_by_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  tokenHash: varchar('token_hash', { length: 255 }).notNull().unique(),
  status: invitationStatusEnum('status').default('pending').notNull(),
  note: text('note'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const organizationsRelations = relations(organizations, ({ many }) => ({
  members: many(organizationMembers),
  invitations: many(organizationInvitations),
  projects: many(projects),
}));

export const organizationMembersRelations = relations(organizationMembers, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationMembers.organizationId],
    references: [organizations.id],
  }),
  user: one(users, {
    fields: [organizationMembers.userId],
    references: [users.id],
  }),
  inviter: one(users, {
    fields: [organizationMembers.invitedBy],
    references: [users.id],
  }),
}));

export const organizationInvitationsRelations = relations(organizationInvitations, ({ one }) => ({
  organization: one(organizations, {
    fields: [organizationInvitations.organizationId],
    references: [organizations.id],
  }),
  invitedBy: one(users, {
    fields: [organizationInvitations.invitedByUserId],
    references: [users.id],
  }),
}));
