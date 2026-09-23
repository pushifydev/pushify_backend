import { pgTable, uuid, timestamp, real, bigint, varchar, primaryKey } from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { deployments } from './deployments';

/**
 * Container metrics - stores periodic snapshots of container resource usage
 */
export const containerMetrics = pgTable('container_metrics', {
  id: uuid('id').defaultRandom().primaryKey(),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),
  deploymentId: uuid('deployment_id').references(() => deployments.id, { onDelete: 'set null' }),
  containerName: varchar('container_name', { length: 255 }).notNull(),

  // CPU metrics
  cpuPercent: real('cpu_percent').notNull(), // 0-100+

  // Memory metrics
  memoryUsageBytes: bigint('memory_usage_bytes', { mode: 'number' }).notNull(),
  memoryLimitBytes: bigint('memory_limit_bytes', { mode: 'number' }).notNull(),
  memoryPercent: real('memory_percent').notNull(), // 0-100

  // Network I/O
  networkRxBytes: bigint('network_rx_bytes', { mode: 'number' }).notNull(),
  networkTxBytes: bigint('network_tx_bytes', { mode: 'number' }).notNull(),

  // Block I/O
  blockReadBytes: bigint('block_read_bytes', { mode: 'number' }).notNull(),
  blockWriteBytes: bigint('block_write_bytes', { mode: 'number' }).notNull(),

  // Container info
  containerStatus: varchar('container_status', { length: 50 }).notNull(), // running, paused, etc.
  pids: bigint('pids', { mode: 'number' }), // number of processes

  recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
});

export type ContainerMetric = typeof containerMetrics.$inferSelect;
export type NewContainerMetric = typeof containerMetrics.$inferInsert;

/**
 * How long a project's containers have been over a resource threshold, and whether anyone has
 * been told. One row per project per resource, so a memory warning and a CPU warning can be
 * live at the same time without overwriting each other.
 *
 * Readings themselves live in `container_metrics`; this is only the alerting state, because
 * deciding "is this a problem" from raw samples on every poll would mean re-reading minutes of
 * history fifteen seconds apart.
 */
export const projectResourceState = pgTable(
  'project_resource_state',
  {
    projectId: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** memory | cpu */
    resource: varchar('resource', { length: 16 }).notNull(),
    /** When the reading first went over the line; null while it is under */
    since: timestamp('since', { withTimezone: true }),
    /** When someone was told; null if the pressure has not lasted long enough yet */
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
    lastPercent: real('last_percent'),
    /** The container the worst reading came from — a project can run several */
    lastContainer: varchar('last_container', { length: 255 }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.resource], name: 'project_resource_state_pk' }),
  })
);

export type ProjectResourceState = typeof projectResourceState.$inferSelect;
