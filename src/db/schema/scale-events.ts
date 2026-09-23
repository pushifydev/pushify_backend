import { pgTable, uuid, integer, real, text, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { projects } from './projects';

/**
 * Every time autoscaling decided the container count should change — including the times it was
 * only watching and changed nothing.
 *
 * Kept apart from the activity log because the question it answers is a different one: not "who
 * did what to this project" but "is this policy right for this workload". Seeing the decisions
 * next to the CPU that caused them is what tells someone their thresholds are wrong.
 */
export const projectScaleEvents = pgTable(
  'project_scale_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromCount: integer('from_count').notNull(),
    toCount: integer('to_count').notNull(),
    /** The reading behind the decision, so a threshold can be judged against it */
    averageCpu: real('average_cpu'),
    reason: text('reason').notNull(),
    /** False when the project was only observing — the decision was recorded, not carried out */
    applied: boolean('applied').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    byProject: index('project_scale_events_project_created_idx').on(table.projectId, table.createdAt),
  })
);

export const projectScaleEventsRelations = relations(projectScaleEvents, ({ one }) => ({
  project: one(projects, { fields: [projectScaleEvents.projectId], references: [projects.id] }),
}));

export type ProjectScaleEvent = typeof projectScaleEvents.$inferSelect;
