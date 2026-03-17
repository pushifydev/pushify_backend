import { eq, and, desc, lte } from 'drizzle-orm';
import { db } from '../db';
import {
  databases,
  databaseBackups,
  databaseConnections,
  type Database,
  type NewDatabase,
  type DatabaseBackup,
  type NewDatabaseBackup,
  type DatabaseConnection,
  type NewDatabaseConnection,
} from '../db/schema';

export const databaseRepository = {
  // ============ Databases ============

  // Find all databases for an organization
  async findByOrganization(organizationId: string): Promise<Database[]> {
    return db.query.databases.findMany({
      where: eq(databases.organizationId, organizationId),
      orderBy: [desc(databases.createdAt)],
      with: {
        server: true,
      },
    });
  },

  // Find database by ID
  async findById(id: string): Promise<Database | undefined> {
    return db.query.databases.findFirst({
      where: eq(databases.id, id),
      with: {
        server: true,
        backups: {
          orderBy: [desc(databaseBackups.startedAt)],
          limit: 5,
        },
        connections: {
          with: {
            project: true,
          },
        },
      },
    });
  },

  // Find database by name within organization
  async findByName(organizationId: string, name: string): Promise<Database | undefined> {
    return db.query.databases.findFirst({
      where: and(
        eq(databases.organizationId, organizationId),
        eq(databases.name, name)
      ),
    });
  },

  // Find databases by server
  async findByServer(serverId: string): Promise<Database[]> {
    return db.query.databases.findMany({
      where: eq(databases.serverId, serverId),
      orderBy: [desc(databases.createdAt)],
    });
  },

  // Create database
  async create(data: NewDatabase): Promise<Database> {
    const [database] = await db
      .insert(databases)
      .values(data)
      .returning();

    return database;
  },

  // Update database
  async update(
    id: string,
    data: Partial<Omit<NewDatabase, 'id' | 'organizationId'>>
  ): Promise<Database | undefined> {
    const [database] = await db
      .update(databases)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(databases.id, id))
      .returning();

    return database;
  },

  // Delete database
  async delete(id: string): Promise<void> {
    await db.delete(databases).where(eq(databases.id, id));
  },

  // ============ Backups ============

  // Find backups by database
  async findBackupsByDatabase(databaseId: string, limit = 20): Promise<DatabaseBackup[]> {
    return db.query.databaseBackups.findMany({
      where: eq(databaseBackups.databaseId, databaseId),
      orderBy: [desc(databaseBackups.startedAt)],
      limit,
    });
  },

  // Find backup by ID
  async findBackupById(id: string): Promise<DatabaseBackup | undefined> {
    return db.query.databaseBackups.findFirst({
      where: eq(databaseBackups.id, id),
    });
  },

  // Create backup
  async createBackup(data: NewDatabaseBackup): Promise<DatabaseBackup> {
    const [backup] = await db
      .insert(databaseBackups)
      .values(data)
      .returning();

    return backup;
  },

  // Update backup
  async updateBackup(
    id: string,
    data: Partial<Omit<NewDatabaseBackup, 'id' | 'databaseId'>>
  ): Promise<DatabaseBackup | undefined> {
    const [backup] = await db
      .update(databaseBackups)
      .set(data)
      .where(eq(databaseBackups.id, id))
      .returning();

    return backup;
  },

  // Delete backup
  async deleteBackup(id: string): Promise<void> {
    await db.delete(databaseBackups).where(eq(databaseBackups.id, id));
  },

  // Find databases with backup enabled (for worker)
  async findDatabasesWithBackupEnabled(): Promise<Database[]> {
    return db.query.databases.findMany({
      where: and(
        eq(databases.backupEnabled, true),
        eq(databases.status, 'running')
      ),
      with: {
        server: true,
      },
    });
  },

  // Find expired backups (for cleanup)
  async findExpiredBackups(): Promise<DatabaseBackup[]> {
    return db.query.databaseBackups.findMany({
      where: and(
        lte(databaseBackups.expiresAt, new Date()),
        eq(databaseBackups.status, 'completed')
      ),
    });
  },

  // ============ Connections ============

  // Find connections by database
  async findConnectionsByDatabase(databaseId: string): Promise<DatabaseConnection[]> {
    return db.query.databaseConnections.findMany({
      where: eq(databaseConnections.databaseId, databaseId),
      with: {
        project: true,
      },
    });
  },

  // Find connections by project
  async findConnectionsByProject(projectId: string): Promise<DatabaseConnection[]> {
    return db.query.databaseConnections.findMany({
      where: eq(databaseConnections.projectId, projectId),
      with: {
        database: true,
      },
    });
  },

  // Find connection by ID
  async findConnectionById(id: string): Promise<DatabaseConnection | undefined> {
    return db.query.databaseConnections.findFirst({
      where: eq(databaseConnections.id, id),
      with: {
        database: true,
        project: true,
      },
    });
  },

  // Check if connection already exists
  async connectionExists(databaseId: string, projectId: string): Promise<boolean> {
    const existing = await db.query.databaseConnections.findFirst({
      where: and(
        eq(databaseConnections.databaseId, databaseId),
        eq(databaseConnections.projectId, projectId)
      ),
    });
    return !!existing;
  },

  // Create connection
  async createConnection(data: NewDatabaseConnection): Promise<DatabaseConnection> {
    const [connection] = await db
      .insert(databaseConnections)
      .values(data)
      .returning();

    return connection;
  },

  // Update connection
  async updateConnection(
    id: string,
    data: Partial<Omit<NewDatabaseConnection, 'id' | 'databaseId' | 'projectId'>>
  ): Promise<DatabaseConnection | undefined> {
    const [connection] = await db
      .update(databaseConnections)
      .set(data)
      .where(eq(databaseConnections.id, id))
      .returning();

    return connection;
  },

  // Delete connection
  async deleteConnection(id: string): Promise<void> {
    await db.delete(databaseConnections).where(eq(databaseConnections.id, id));
  },
};
