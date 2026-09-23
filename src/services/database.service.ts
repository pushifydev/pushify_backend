import { HTTPException } from 'hono/http-exception';
import { databaseRepository } from '../repositories/database.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { projectRepository } from '../repositories/project.repository';
import { t, type SupportedLocale } from '../i18n';
import { encrypt, decrypt } from '../lib/encryption';
import { SSHClient } from '../utils/ssh';
import { db } from '../db';
import { eq } from 'drizzle-orm';
import { servers } from '../db/schema/servers';
import type { DatabaseType } from '../db/schema/databases';
import { planLimitsService } from './plan-limits.service';
import { assertOrganizationCanMutateResources } from './organization-billing.service';
import crypto from 'crypto';
import { adminNotify } from './admin-notify.service';
import { logger } from '../lib/logger';
import {
  DATABASE_DEFAULTS,
  DATABASE_NETWORK,
  buildConnectionString,
  buildDatabaseRunCommand,
  buildReadonlyUserCommand,
  databaseDataDir,
  internalConnectionString,
  isDatabaseType,
  validateDatabaseVersion,
  validateEnvVarName,
} from '../lib/managed-database';

// ============ Types ============

export interface CreateDatabaseInput {
  name: string;
  description?: string;
  type: DatabaseType;
  version?: string;
  serverId: string;
}

export interface UpdateDatabaseInput {
  name?: string;
  description?: string;
  backupEnabled?: boolean;
  backupRetentionDays?: number;
  /** How often an automatic backup runs — the customer's worst-case data loss */
  backupIntervalHours?: number;
  externalAccess?: boolean;
}

export interface ConnectDatabaseInput {
  projectId: string;
  envVarName?: string;
  permissions?: 'readonly' | 'readwrite';
}

// ============ Helper Functions ============

function generatePassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

function generateDatabaseName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '_').substring(0, 32);
}

function generateUsername(name: string): string {
  return `user_${name.toLowerCase().replace(/[^a-z0-9]/g, '').substring(0, 16)}`;
}

// ============ Service ============

export const databaseService = {
  // List all databases for organization
  async list(
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    // Verify user belongs to organization
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const databases = await databaseRepository.findByOrganization(organizationId);

    // Decrypt connection strings for response
    return databases.map((db) => ({
      ...db,
      password: '••••••••', // Never expose actual password in list
      readonlyPassword: undefined,
      connectionString: db.connectionString ? '••••••••' : null,
    }));
  },

  // Get single database
  async get(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    return {
      ...database,
      password: '••••••••',
      readonlyPassword: undefined,
      connectionString: database.connectionString ? '••••••••' : null,
    };
  },

  // Get connection details (with actual credentials)
  async getConnectionDetails(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    // Decrypt credentials
    const password = decrypt(database.password);
    const connectionString = database.connectionString ? decrypt(database.connectionString) : null;

    return {
      host: database.host,
      port: database.port,
      databaseName: database.databaseName,
      username: database.username,
      password,
      connectionString,
      // What apps on the same server use (Pushify injects it into linked projects at deploy).
      internalHost: database.containerName,
      internalPort: DATABASE_DEFAULTS[database.type].port,
      internalConnectionString: database.containerName
        ? internalConnectionString(
            {
              type: database.type,
              containerName: database.containerName,
              username: database.username,
              databaseName: database.databaseName,
            },
            password
          )
        : null,
    };
  },

  // Create new database
  async create(
    organizationId: string,
    userId: string,
    input: CreateDatabaseInput,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    // The route passes the raw body; type and version end up in a root shell on the server.
    const hasVersion = input.version !== undefined && input.version !== null && input.version !== '';
    const inputError = [
      typeof input.name !== 'string' || !input.name.trim() || input.name.length > 64 ? 'Name must be 1–64 characters' : null,
      !isDatabaseType(input.type) ? 'Unknown database type' : null,
      hasVersion ? (typeof input.version === 'string' ? validateDatabaseVersion(input.version) : 'Version must be a string') : null,
      typeof input.serverId !== 'string' || !input.serverId ? 'Server is required' : null,
    ].find((error) => error !== null);
    if (inputError) {
      throw new HTTPException(400, { message: inputError });
    }

    await assertOrganizationCanMutateResources(organizationId, locale);

    await planLimitsService.assertDatabasesQuota(organizationId, locale);

    // Check if name already exists
    const existing = await databaseRepository.findByName(organizationId, input.name);
    if (existing) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'nameExists') });
    }

    // Get server
    const server = await db.query.servers.findFirst({
      where: eq(servers.id, input.serverId),
    });

    if (!server || server.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'servers', 'notFound') });
    }

    if (server.status !== 'running' || server.setupStatus !== 'completed') {
      throw new HTTPException(400, { message: t(locale, 'databases', 'serverNotReady') });
    }

    // Get defaults for database type
    const defaults = DATABASE_DEFAULTS[input.type];
    const version = input.version || defaults.version;

    // Generate credentials
    const password = generatePassword();
    const databaseName = generateDatabaseName(input.name);
    const username = generateUsername(input.name);

    // Find available port (starting from default + offset based on existing DBs)
    const existingDbs = await databaseRepository.findByServer(input.serverId);
    // "My DB" and "my_db" become the same container and data directory on the server.
    if (existingDbs.some((existingDb) => existingDb.databaseName === databaseName)) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'nameExists') });
    }
    const usedPorts = existingDbs.map((db) => db.containerPort).filter(Boolean) as number[];
    let containerPort = defaults.port + 1000; // Start from port + 1000 to avoid conflicts
    while (usedPorts.includes(containerPort)) {
      containerPort++;
    }

    // Create database record
    const database = await databaseRepository.create({
      organizationId,
      serverId: input.serverId,
      name: input.name,
      description: input.description,
      type: input.type,
      version,
      host: server.ipv4 || 'localhost',
      port: containerPort,
      databaseName,
      username,
      password: encrypt(password),
      connectionString: encrypt(
        buildConnectionString(input.type, server.ipv4 || 'localhost', containerPort, username, password, databaseName)
      ),
      status: 'provisioning',
      containerName: `pushify-db-${databaseName}`,
      containerPort,
    });

    // Provision database container asynchronously
    this.provisionDatabase(database.id, server, input.type, version, containerPort, databaseName, username, password)
      .catch((error) => {
        console.error(`Failed to provision database ${database.id}:`, error);
        databaseRepository.update(database.id, {
          status: 'error',
          statusMessage: error.message,
        });
      });

    adminNotify('database.created', {
      database: database.name,
      type: database.type,
      organizationId: database.organizationId,
    });

    return {
      ...database,
      password: '••••••••',
      readonlyPassword: undefined,
      connectionString: '••••••••',
    };
  },

  // Provision database container on server
  async provisionDatabase(
    databaseId: string,
    server: { ipv4: string | null; sshPrivateKey: string | null },
    type: DatabaseType,
    version: string,
    containerPort: number,
    databaseName: string,
    username: string,
    password: string
  ) {
    if (!server.ipv4 || !server.sshPrivateKey) {
      throw new Error('Server not configured for SSH');
    }

    const ssh = new SSHClient();
    await ssh.connect({
      host: server.ipv4,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    try {
      const containerName = `pushify-db-${databaseName}`;

      // A database deleted earlier under the same name left its data directory behind; the image
      // would reuse it with the OLD credentials and the new ones would never work. Keep it aside.
      const dataDir = databaseDataDir(databaseName);
      await ssh.exec(
        `if [ -d ${dataDir} ] && [ -n "$(ls -A ${dataDir} 2>/dev/null)" ]; then mkdir -p /opt/pushify/databases/.old && mv ${dataDir} /opt/pushify/databases/.old/${databaseName}-$(date +%s); fi`
      );
      await ssh.exec(`mkdir -p ${dataDir}`);
      await ssh.exec(`docker network create ${DATABASE_NETWORK} 2>/dev/null || true`);

      const runResult = await ssh.exec(
        buildDatabaseRunCommand({
          type,
          version,
          containerName,
          hostPort: containerPort,
          externalAccess: false,
          databaseName,
          username,
          password,
        })
      );
      if (runResult.code !== 0) {
        throw new Error(`Could not start the database container: ${(runResult.stderr || runResult.stdout).trim().slice(0, 300)}`);
      }

      // Wait for container to be healthy
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Verify container is running
      const { stdout } = await ssh.exec(`docker inspect -f '{{.State.Running}}' ${containerName}`);
      if (stdout.trim() !== 'true') {
        throw new Error('Container failed to start');
      }

      // Update database status to running
      await databaseRepository.update(databaseId, {
        status: 'running',
        statusMessage: null,
      });
    } finally {
      ssh.disconnect();
    }
  },

  // Update database
  async update(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: UpdateDatabaseInput,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    // Whitelist updatable fields — the route forwards the raw request body, so without this
    // an attacker could set host/password/connectionString/serverId/status via the body (M-4).
    const safeInput: UpdateDatabaseInput = {};
    if (typeof input.name === 'string') safeInput.name = input.name;
    if (typeof input.description === 'string') safeInput.description = input.description;
    if (typeof input.backupEnabled === 'boolean') safeInput.backupEnabled = input.backupEnabled;
    if (typeof input.backupRetentionDays === 'number') safeInput.backupRetentionDays = input.backupRetentionDays;
    if (typeof input.backupIntervalHours === 'number') {
      // The plan sets the floor: backing up every hour costs storage and load on the database
      // itself, so it is what a paid plan buys. Above the floor it is the customer's call.
      const { getEffectivePlanLimits } = await import('../lib/effective-plan-limits');
      const { resolveBackupInterval } = await import('../lib/backup-schedule');
      const org = await organizationRepository.findById(organizationId);
      const limits = getEffectivePlanLimits({
        plan: org?.plan ?? 'free',
        grandfatheredUntil: org?.grandfatheredUntil,
        planLimitsOverride: org?.planLimitsOverride,
      });
      const resolved = resolveBackupInterval(input.backupIntervalHours, limits);
      if ('error' in resolved) throw new HTTPException(400, { message: resolved.error });
      safeInput.backupIntervalHours = resolved.hours;
    }
    if (typeof input.externalAccess === 'boolean') safeInput.externalAccess = input.externalAccess;

    // Check name uniqueness if changing
    if (safeInput.name && safeInput.name !== database.name) {
      const existing = await databaseRepository.findByName(organizationId, safeInput.name);
      if (existing) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'nameExists') });
      }
    }

    const updated = await databaseRepository.update(databaseId, safeInput);
    return {
      ...updated,
      password: '••••••••',
      readonlyPassword: undefined,
      connectionString: '••••••••',
    };
  },

  // Delete database
  async delete(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    // Update status to deleting
    await databaseRepository.update(databaseId, { status: 'deleting' });

    // Delete container asynchronously
    if (database.serverId && database.containerName) {
      this.deleteContainer(
        database.serverId,
        database.containerName,
        database.containerPort,
        database.externalAccess
      ).catch((error) => console.error(`Failed to delete container:`, error));
    }

    // …and the copies kept off the server. Leaving them would keep a deleted customer's data
    // in the operator's storage indefinitely, which is not what "delete" means.
    import('./offsite-backup.service')
      .then(({ offsiteBackupService }) => offsiteBackupService.purge(organizationId, databaseId))
      .catch(() => undefined);

    // Delete database record
    await databaseRepository.delete(databaseId);
    adminNotify('database.deleted', { databaseId });
  },

  // Delete container on server
  async deleteContainer(
    serverId: string,
    containerName: string,
    containerPort: number | null,
    externalAccess: boolean
  ) {
    const server = await db.query.servers.findFirst({
      where: eq(servers.id, serverId),
    });

    if (!server?.ipv4 || !server.sshPrivateKey) {
      return;
    }

    const ssh = new SSHClient();
    await ssh.connect({
      host: server.ipv4,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    try {
      await ssh.exec(`docker stop ${containerName} || true`);
      await ssh.exec(`docker rm ${containerName} || true`);

      // Remove firewall rule if external access was enabled
      if (externalAccess && containerPort) {
        await ssh.exec(`ufw delete allow ${containerPort}/tcp || true`);
      }
    } finally {
      ssh.disconnect();
    }
  },

  // Connect database to project
  async connectToProject(
    databaseId: string,
    organizationId: string,
    userId: string,
    input: ConnectDatabaseInput,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    const project = await projectRepository.findById(input.projectId);
    if (!project || project.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'projects', 'notFound') });
    }

    // Becomes a variable name in the app container at deploy.
    const envVarError = input.envVarName ? validateEnvVarName(input.envVarName) : null;
    if (envVarError) {
      throw new HTTPException(400, { message: envVarError });
    }
    const permissions = input.permissions || 'readwrite';
    if (permissions !== 'readonly' && permissions !== 'readwrite') {
      throw new HTTPException(400, { message: 'Permissions must be readonly or readwrite' });
    }
    // Read-only means a database user that can only read — set it up now, so a problem shows
    // here and not at the project's next deploy.
    if (permissions === 'readonly') {
      await this.ensureReadonlyUser(databaseId);
    }

    // Check if connection already exists
    const exists = await databaseRepository.connectionExists(databaseId, input.projectId);
    if (exists) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'alreadyConnected') });
    }

    const connection = await databaseRepository.createConnection({
      databaseId,
      projectId: input.projectId,
      envVarName: input.envVarName || 'DATABASE_URL',
      permissions,
    });

    return connection;
  },

  /**
   * The read-only user that projects connected with permissions 'readonly' get (lib/managed-
   * database.ts buildReadonlyUserCommand): created the first time, grants re-applied every time.
   * Redis has none.
   */
  async ensureReadonlyUser(databaseId: string): Promise<{ username: string; password: string }> {
    const database = await databaseRepository.findById(databaseId);
    if (!database) {
      throw new HTTPException(404, { message: 'Database not found' });
    }
    if (database.type === 'redis') {
      throw new HTTPException(400, { message: 'Redis has no read-only mode — connect it with read & write access' });
    }
    if (database.status !== 'running' || !database.serverId || !database.containerName) {
      throw new HTTPException(400, { message: 'The database must be running to set up read-only access' });
    }
    const server = await db.query.servers.findFirst({ where: eq(servers.id, database.serverId) });
    if (!server?.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: 'The database server is not reachable over SSH' });
    }

    const username = database.readonlyUsername || `${database.username}_ro`;
    const password = database.readonlyPassword ? decrypt(database.readonlyPassword) : generatePassword();
    const ssh = new SSHClient();
    await ssh.connect({ host: server.ipv4, username: 'root', privateKey: decrypt(server.sshPrivateKey) });
    try {
      const result = await ssh.exec(
        buildReadonlyUserCommand({
          type: database.type,
          containerName: database.containerName,
          username: database.username,
          password: decrypt(database.password),
          databaseName: database.databaseName,
          readonlyUsername: username,
          readonlyPassword: password,
        })
      );
      const ok = result.code === 0 && (database.type !== 'mongodb' || result.stdout.includes('PUSHIFY_RO_OK'));
      if (!ok) {
        logger.error({ databaseId, stderr: result.stderr, stdout: result.stdout }, 'Read-only user setup failed');
        throw new HTTPException(500, {
          message: `Read-only access could not be set up: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
        });
      }
    } finally {
      ssh.disconnect();
    }
    if (!database.readonlyUsername || !database.readonlyPassword) {
      await databaseRepository.update(databaseId, { readonlyUsername: username, readonlyPassword: encrypt(password) });
    }
    return { username, password };
  },

  // Disconnect database from project
  async disconnectFromProject(
    connectionId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const connection = await databaseRepository.findConnectionById(connectionId);
    if (!connection) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'connectionNotFound') });
    }

    // Verify the connection's database belongs to this organization.
    // databaseConnections has no organizationId, so without this check any user
    // could delete another tenant's connection by id (H-2 IDOR).
    const database = await databaseRepository.findById(connection.databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'connectionNotFound') });
    }

    await databaseRepository.deleteConnection(connectionId);
  },

  // Get available database types
  getAvailableTypes() {
    return Object.entries(DATABASE_DEFAULTS).map(([type, config]) => ({
      type,
      defaultVersion: config.version,
      defaultPort: config.port,
    }));
  },

  // Toggle external access for database
  async toggleExternalAccess(
    databaseId: string,
    organizationId: string,
    userId: string,
    enable: boolean,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    if (database.status !== 'running') {
      throw new HTTPException(400, { message: t(locale, 'databases', 'mustBeRunning') });
    }

    if (!database.serverId || !database.containerName || !database.containerPort) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'invalidContainer') });
    }

    // Get server
    const server = await db.query.servers.findFirst({
      where: eq(servers.id, database.serverId),
    });

    if (!server?.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
    }

    // Reconfigure container with new port binding
    await this.reconfigureContainer(
      database,
      server,
      enable
    );

    // Update database record
    const updated = await databaseRepository.update(databaseId, {
      externalAccess: enable,
    });

    return {
      ...updated,
      password: '••••••••',
      readonlyPassword: undefined,
      connectionString: '••••••••',
    };
  },

  // Reconfigure container port binding
  async reconfigureContainer(
    database: {
      containerName: string | null;
      containerPort: number | null;
      type: DatabaseType;
      version: string;
      databaseName: string;
      username: string;
      password: string;
    },
    server: { ipv4: string | null; sshPrivateKey: string | null },
    externalAccess: boolean
  ) {
    if (!server.ipv4 || !server.sshPrivateKey) {
      throw new Error('Server not configured for SSH');
    }

    const ssh = new SSHClient();
    await ssh.connect({
      host: server.ipv4,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    try {
      const containerName = database.containerName!;
      const containerPort = database.containerPort!;
      const password = decrypt(database.password);

      // Stop and remove existing container
      await ssh.exec(`docker stop ${containerName} || true`);
      await ssh.exec(`docker rm ${containerName} || true`);

      // Recreate with the new port binding (same data directory, same network)
      await ssh.exec(`docker network create ${DATABASE_NETWORK} 2>/dev/null || true`);
      await ssh.exec(
        buildDatabaseRunCommand({
          type: database.type,
          version: database.version,
          containerName,
          hostPort: containerPort,
          externalAccess,
          databaseName: database.databaseName,
          username: database.username,
          password,
        })
      );

      // Wait for container to start
      await new Promise((resolve) => setTimeout(resolve, 5000));

      // Verify container is running
      const { stdout } = await ssh.exec(`docker inspect -f '{{.State.Running}}' ${containerName}`);
      if (stdout.trim() !== 'true') {
        throw new Error('Container failed to restart');
      }

      // Configure firewall
      if (externalAccess) {
        // Open port in firewall for external access
        await ssh.exec(`ufw allow ${containerPort}/tcp comment 'Pushify DB: ${database.databaseName}'`);

        // For MySQL, ensure user can connect from any host
        if (database.type === 'mysql') {
          // Wait a bit more for MySQL to be fully ready
          await new Promise((resolve) => setTimeout(resolve, 5000));
          // Grant user access from any host
          await ssh.exec(`docker exec ${containerName} mysql -u root -p'${password}' -e "CREATE USER IF NOT EXISTS '${database.username}'@'%' IDENTIFIED BY '${password}'; GRANT ALL PRIVILEGES ON ${database.databaseName}.* TO '${database.username}'@'%'; FLUSH PRIVILEGES;" || true`);
        }
      } else {
        // Close port in firewall
        await ssh.exec(`ufw delete allow ${containerPort}/tcp || true`);
      }
    } finally {
      ssh.disconnect();
    }
  },

  // Restart database container
  async restart(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    if (!database.serverId || !database.containerName) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'invalidContainer') });
    }

    const server = await db.query.servers.findFirst({
      where: eq(servers.id, database.serverId),
    });

    if (!server?.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
    }

    const ssh = new SSHClient();
    await ssh.connect({
      host: server.ipv4,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    try {
      await ssh.exec(`docker restart ${database.containerName}`);
    } finally {
      ssh.disconnect();
    }

    return { success: true };
  },

  // Stop database container
  async stop(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    if (!database.serverId || !database.containerName) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'invalidContainer') });
    }

    const server = await db.query.servers.findFirst({
      where: eq(servers.id, database.serverId),
    });

    if (!server?.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
    }

    const ssh = new SSHClient();
    await ssh.connect({
      host: server.ipv4,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    try {
      await ssh.exec(`docker stop ${database.containerName}`);
      await databaseRepository.update(databaseId, { status: 'stopped' });
    } finally {
      ssh.disconnect();
    }

    return { success: true };
  },

  // Reset database password
  async resetPassword(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    if (database.status !== 'running') {
      throw new HTTPException(400, { message: t(locale, 'databases', 'mustBeRunning') });
    }

    if (!database.serverId || !database.containerName || !database.containerPort) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'invalidContainer') });
    }

    const server = await db.query.servers.findFirst({
      where: eq(servers.id, database.serverId),
    });

    if (!server?.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
    }

    // Generate new password
    const newPassword = generatePassword();

    // Update password in container
    const ssh = new SSHClient();
    await ssh.connect({
      host: server.ipv4,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    try {
      const containerName = database.containerName!;
      const oldPassword = decrypt(database.password);
      const user = database.username;

      let result: { code: number; stdout: string; stderr: string };
      switch (database.type) {
        case 'postgresql':
          // -d: psql otherwise connects to a database named after the user, which doesn't exist.
          result = await ssh.exec(
            `docker exec ${containerName} psql -v ON_ERROR_STOP=1 -U ${user} -d ${database.databaseName} -c "ALTER USER \\"${user}\\" PASSWORD '${newPassword}';"`
          );
          break;

        case 'mysql':
          // root was created with the same password; keep them in step so later admin calls work.
          result = await ssh.exec(
            `docker exec -e MYSQL_PWD='${oldPassword}' ${containerName} mysql -u root -e "ALTER USER '${user}'@'%' IDENTIFIED BY '${newPassword}'; ALTER USER 'root'@'%' IDENTIFIED BY '${newPassword}'; ALTER USER 'root'@'localhost' IDENTIFIED BY '${newPassword}'; FLUSH PRIVILEGES;"`
          );
          break;

        case 'redis':
          // The password lives on the container's command line (--requirepass): CONFIG SET would be
          // undone by the next restart. Recreate the container; stopping it saves the dataset first.
          await ssh.exec(`docker stop ${containerName} 2>/dev/null; docker rm ${containerName} 2>/dev/null; true`);
          await ssh.exec(`docker network create ${DATABASE_NETWORK} 2>/dev/null || true`);
          result = await ssh.exec(
            buildDatabaseRunCommand({
              type: 'redis',
              version: database.version,
              containerName,
              hostPort: database.containerPort!,
              externalAccess: database.externalAccess,
              databaseName: database.databaseName,
              username: user,
              password: newPassword,
            })
          );
          break;

        case 'mongodb':
          result = await ssh.exec(
            `docker exec ${containerName} mongosh --quiet -u ${user} -p '${oldPassword}' --authenticationDatabase admin admin --eval "db.changeUserPassword('${user}', '${newPassword}')"`
          );
          break;
      }

      // Storing a password the database never accepted would lock Pushify (backups, studio) out.
      if (result.code !== 0) {
        logger.error({ databaseId, stderr: result.stderr }, 'Database password reset failed');
        throw new HTTPException(500, {
          message: `Password could not be changed: ${(result.stderr || result.stdout).trim().slice(0, 200)}`,
        });
      }
    } finally {
      ssh.disconnect();
    }

    // Update database record with new encrypted password and connection string
    const newConnectionString = buildConnectionString(
      database.type,
      database.host || server.ipv4,
      database.port,
      database.username,
      newPassword,
      database.databaseName
    );

    await databaseRepository.update(databaseId, {
      password: encrypt(newPassword),
      connectionString: encrypt(newConnectionString),
    });

    return {
      password: newPassword,
      connectionString: newConnectionString,
    };
  },

  // Start database container
  async start(
    databaseId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const database = await databaseRepository.findById(databaseId);
    if (!database || database.organizationId !== organizationId) {
      throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
    }

    if (!database.serverId || !database.containerName) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'invalidContainer') });
    }

    const server = await db.query.servers.findFirst({
      where: eq(servers.id, database.serverId),
    });

    if (!server?.ipv4 || !server.sshPrivateKey) {
      throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
    }

    const ssh = new SSHClient();
    await ssh.connect({
      host: server.ipv4,
      username: 'root',
      privateKey: decrypt(server.sshPrivateKey),
    });

    try {
      await ssh.exec(`docker start ${database.containerName}`);
      await databaseRepository.update(databaseId, { status: 'running' });
    } finally {
      ssh.disconnect();
    }

    return { success: true };
  },
};
