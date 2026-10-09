import { pgTable, uuid, varchar, timestamp, integer, text, jsonb, index } from 'drizzle-orm/pg-core';
import { organizations } from './organizations';
import { projects } from './projects';
import { deployments } from './deployments';
import { users } from './users';

/** One reason behind a flag. No file content and no traffic content — only where a rule matched. */
export interface AbuseReason {
  ruleId: string;
  weight: number;
  strength: 'strong' | 'medium' | 'weak';
  message: string;
  file?: string;
  line?: number;
}

/**
 * The review queue. A project gets at most one open flag per source; a new finding from the same
 * source updates it. `source`: deploy_scan | runtime | report. `status`: open | dismissed | actioned.
 */
export const abuseFlags = pgTable(
  'abuse_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    organizationId: uuid('organization_id').references(() => organizations.id, { onDelete: 'cascade' }),
    deploymentId: uuid('deployment_id').references(() => deployments.id, { onDelete: 'set null' }),
    source: varchar('source', { length: 16 }).notNull(),
    status: varchar('status', { length: 16 }).default('open').notNull(),
    score: integer('score').default(0).notNull(),
    reasons: jsonb('reasons').$type<AbuseReason[]>().default([]).notNull(),
    /** External reports: the URL as reported, who reported it and what they wrote */
    reportedUrl: varchar('reported_url', { length: 500 }),
    reporterEmail: varchar('reporter_email', { length: 255 }),
    reportText: text('report_text'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    statusIdx: index('abuse_flags_status_idx').on(t.status, t.createdAt),
    projectIdx: index('abuse_flags_project_idx').on(t.projectId),
  })
);

/** Audit trail of every admin decision on abuse: suspend, unsuspend, dismiss. Never updated. */
export const abuseActions = pgTable(
  'abuse_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    flagId: uuid('flag_id').references(() => abuseFlags.id, { onDelete: 'set null' }),
    adminUserId: uuid('admin_user_id').references(() => users.id, { onDelete: 'set null' }),
    action: varchar('action', { length: 16 }).notNull(),
    reason: text('reason'),
    clause: varchar('clause', { length: 64 }),
    endsAt: timestamp('ends_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    projectIdx: index('abuse_actions_project_idx').on(t.projectId, t.createdAt),
  })
);

export type AbuseFlag = typeof abuseFlags.$inferSelect;
export type AbuseAction = typeof abuseActions.$inferSelect;
