import { pgTable, uuid, timestamp, bigint, primaryKey } from 'drizzle-orm/pg-core';
import { projects } from './projects';

/**
 * Per-app HTTP traffic, one row per project per hour, aggregated on the server from the app's
 * Nginx access log (see lib/traffic-analytics.ts). Only totals are kept — no IPs, paths or user
 * agents — and rows older than the retention window are deleted by the retention sweep.
 */
export const projectTrafficHourly = pgTable(
  'project_traffic_hourly',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Start of the hour (UTC) */
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    requests: bigint('requests', { mode: 'number' }).default(0).notNull(),
    status4xx: bigint('status_4xx', { mode: 'number' }).default(0).notNull(),
    status5xx: bigint('status_5xx', { mode: 'number' }).default(0).notNull(),
    /** Response body bytes sent to clients ($body_bytes_sent) */
    bytesSent: bigint('bytes_sent', { mode: 'number' }).default(0).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.hour], name: 'project_traffic_hourly_pk' }),
  })
);

export type ProjectTrafficHourly = typeof projectTrafficHourly.$inferSelect;
export type NewProjectTrafficHourly = typeof projectTrafficHourly.$inferInsert;
