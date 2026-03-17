import { pgTable, uuid, timestamp, real, bigint, varchar } from 'drizzle-orm/pg-core';
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
