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

// Enums
export const serverStatusEnum = pgEnum('server_status', [
  'provisioning',
  'running',
  'stopped',
  'rebooting',
  'error',
  'deleting',
]);

export const serverSetupStatusEnum = pgEnum('server_setup_status', [
  'pending',      // Waiting for server to be ready
  'installing',   // Cloud-init running, installing packages
  'completed',    // Setup complete, server ready for deployments
  'failed',       // Setup failed
]);

export const serverProviderEnum = pgEnum('server_provider', [
  'hetzner',
  'digitalocean',
  'aws',
  'gcp',
  'self_hosted',
]);

export const serverSizeEnum = pgEnum('server_size', ['xs', 'sm', 'md', 'lg', 'xl', 'custom']);

// Servers Table
export const servers = pgTable('servers', {
  id: uuid('id').primaryKey().defaultRandom(),
  organizationId: uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' }),

  // Basic info
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  // Provider info
  provider: serverProviderEnum('provider').notNull(),
  providerId: varchar('provider_id', { length: 255 }), // ID from the cloud provider
  providerData: jsonb('provider_data').default({}).notNull(), // Provider-specific metadata

  // Server specs
  size: serverSizeEnum('size').default('sm').notNull(),
  region: varchar('region', { length: 100 }).notNull(),
  image: varchar('image', { length: 255 }), // OS image (e.g., ubuntu-22.04)

  // Resources
  vcpus: integer('vcpus').default(1).notNull(),
  memoryMb: integer('memory_mb').default(1024).notNull(),
  diskGb: integer('disk_gb').default(20).notNull(),

  // Network
  ipv4: varchar('ipv4', { length: 45 }),
  ipv6: varchar('ipv6', { length: 45 }),
  privateIp: varchar('private_ip', { length: 45 }),

  // Status
  status: serverStatusEnum('status').default('provisioning').notNull(),
  setupStatus: serverSetupStatusEnum('setup_status').default('pending').notNull(),
  statusMessage: text('status_message'),

  // SSH
  sshKeyId: varchar('ssh_key_id', { length: 255 }), // Provider's SSH key ID
  sshPrivateKey: text('ssh_private_key'), // Encrypted private key for SSH connections
  sshPublicKey: text('ssh_public_key'), // Public key (uploaded to provider)
  rootPassword: text('root_password'), // Encrypted, only for initial setup

  // Metadata
  labels: jsonb('labels').default({}).notNull(),
  isManaged: boolean('is_managed').default(true).notNull(), // Managed by Pushify or BYOC

  // Timestamps
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
});

// Server Snapshots Table
export const serverSnapshots = pgTable('server_snapshots', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),

  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),

  providerId: varchar('provider_id', { length: 255 }), // Snapshot ID from provider
  sizeGb: integer('size_gb'),
  status: varchar('status', { length: 50 }).default('creating').notNull(), // creating, available, error

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Server Firewall Rules Table
export const serverFirewallRules = pgTable('server_firewall_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  serverId: uuid('server_id')
    .notNull()
    .references(() => servers.id, { onDelete: 'cascade' }),

  direction: varchar('direction', { length: 10 }).notNull(), // in, out
  protocol: varchar('protocol', { length: 10 }).notNull(), // tcp, udp, icmp
  port: varchar('port', { length: 20 }), // Can be range like "8000-9000"
  sourceIps: jsonb('source_ips').default([]).notNull(), // Array of CIDR blocks
  description: text('description'),

  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Relations
export const serversRelations = relations(servers, ({ one, many }) => ({
  organization: one(organizations, {
    fields: [servers.organizationId],
    references: [organizations.id],
  }),
  snapshots: many(serverSnapshots),
  firewallRules: many(serverFirewallRules),
}));

export const serverSnapshotsRelations = relations(serverSnapshots, ({ one }) => ({
  server: one(servers, {
    fields: [serverSnapshots.serverId],
    references: [servers.id],
  }),
}));

export const serverFirewallRulesRelations = relations(serverFirewallRules, ({ one }) => ({
  server: one(servers, {
    fields: [serverFirewallRules.serverId],
    references: [servers.id],
  }),
}));
