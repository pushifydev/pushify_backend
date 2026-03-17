import {
  pgTable,
  uuid,
  varchar,
  timestamp,
  text,
  pgEnum,
  jsonb,
  integer,
  boolean,
} from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';
import { organizations } from './organizations';
import { servers } from './servers';
import { projects } from './projects';

// Enums
export const databaseTypeEnum = pgEnum('database_type', [
  'postgresql',
  'mysql',
  'redis',
  'mongodb',
]);

export const databaseStatusEnum = pgEnum('database_status', [
  'provisioning',
  'running',
  'stopped',
  'error',
  'deleting',
]);

// Managed Databases Table
export const databases = pgTable('databases', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  serverId: uuid('server_id')
    .references(() => servers.id, { onDelete: 'set null' }),

  // Basic info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  type: databaseTypeEnum('type').notNull(),

  // Version
  version: varchar('version', { length: 50 }).notNull(), // e.g., "15.4", "8.0", "7.2"

  // Connection details
  host: varchar('host', { length: 255 }),
  port: integer('port').notNull(),
  databaseName: varchar('database_name', { length: 255 }).notNull(),
  username: varchar('username', { length: 255 }).notNull(),
  password: text('password').notNull(), // Encrypted
  connectionString: text('connection_string'), // Encrypted, full connection URL

  // Status
  status: databaseStatusEnum('status').default('provisioning').notNull(),
  statusMessage: text('status_message'),

  // Resources
  maxConnections: integer('max_connections').default(100),
  storageMb: integer('storage_mb').default(1024), // Storage limit in MB
  usedStorageMb: integer('used_storage_mb').default(0),

  // Configuration
  config: jsonb('config').default({}).notNull(), // Database-specific config

  // Backup settings
  backupEnabled: boolean('backup_enabled').default(true).notNull(),
  backupRetentionDays: integer('backup_retention_days').default(7),
  lastBackupAt: timestamp('last_backup_at', { withTimezone: true }),

  // Container info (for Docker-based databases)
  containerName: varchar('container_name', { length: 255 }),
  containerPort: integer('container_port'),

  // Access settings
  externalAccess: boolean('external_access').default(false).notNull(),

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// Database Backups Table
export const databaseBackups = pgTable('database_backups', {
  id: uuid('id').primaryKey().defaultRandom(),
  databaseId: uuid('database_id')
    .notNull()
    .references(() => databases.id, { onDelete: 'cascade' }),

  // Backup info
  name: varchar('name', { length: 255 }).notNull(),
  type: varchar('type', { length: 50 }).default('automatic').notNull(), // automatic, manual
  status: varchar('status', { length: 50 }).default('creating').notNull(), // creating, completed, failed, deleted
  sizeMb: integer('size_mb'),
  filePath: text('file_path'), // Path to backup file on server

  // Metadata
  metadata: jsonb('metadata').default({}).notNull(),
  errorMessage: text('error_message'),

  // Timestamps
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
});

// Database Connections - Link databases to projects
export const databaseConnections = pgTable('database_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  databaseId: uuid('database_id')
    .notNull()
    .references(() => databases.id, { onDelete: 'cascade' }),
  projectId: uuid('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),

  // Environment variable name to inject
  envVarName: varchar('env_var_name', { length: 255 }).default('DATABASE_URL').notNull(),

  // Permissions
  permissions: varchar('permissions', { length: 50 }).default('readwrite').notNull(), // readonly, readwrite

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const databasesRelations = relations(databases, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [databases.organizationId],
    references: [organizations.id],
  }),
  server: one(servers, {
    fields: [databases.serverId],
    references: [servers.id],
  }),
  backups: many(databaseBackups),
  connections: many(databaseConnections),
}));

export const databaseBackupsRelations = relations(databaseBackups, ({ one }) => ({
  database: one(databases, {
    fields: [databaseBackups.databaseId],
    references: [databases.id],
  }),
}));

export const databaseConnectionsRelations = relations(databaseConnections, ({ one }) => ({
  database: one(databases, {
    fields: [databaseConnections.databaseId],
    references: [databases.id],
  }),
  project: one(projects, {
    fields: [databaseConnections.projectId],
    references: [projects.id],
  }),
}));

// Types
export type Database = typeof databases.$inferSelect;
export type NewDatabase = typeof databases.$inferInsert;
export type DatabaseBackup = typeof databaseBackups.$inferSelect;
export type NewDatabaseBackup = typeof databaseBackups.$inferInsert;
export type DatabaseConnection = typeof databaseConnections.$inferSelect;
export type NewDatabaseConnection = typeof databaseConnections.$inferInsert;
export type DatabaseType = 'postgresql' | 'mysql' | 'redis' | 'mongodb';
export type DatabaseStatus = 'provisioning' | 'running' | 'stopped' | 'error' | 'deleting';
