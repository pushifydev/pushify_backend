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
import type { DatabaseType, DatabaseStatus } from '../db/schema/databases';
import { getPlanInfo, isUnlimited, type PlanType } from '../lib/plans';
import crypto from 'crypto';

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
  externalAccess?: boolean;
}

export interface ConnectDatabaseInput {
  projectId: string;
  envVarName?: string;
  permissions?: 'readonly' | 'readwrite';
}

// Database default versions and ports
const DATABASE_DEFAULTS: Record<DatabaseType, { version: string; port: number; image: string }> = {
  postgresql: { version: '16', port: 5432, image: 'postgres' },
  mysql: { version: '8.0', port: 3306, image: 'mysql' },
  redis: { version: '7', port: 6379, image: 'redis' },
  mongodb: { version: '7', port: 27017, image: 'mongo' },
};

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

function buildConnectionString(
  type: DatabaseType,
  host: string,
  port: number,
  username: string,
  password: string,
  databaseName: string
): string {
  // URL encode username and password to handle special characters
  const encodedUser = encodeURIComponent(username);
  const encodedPass = encodeURIComponent(password);

  switch (type) {
    case 'postgresql':
      return `postgresql://${encodedUser}:${encodedPass}@${host}:${port}/${databaseName}`;
    case 'mysql':
      return `mysql://${encodedUser}:${encodedPass}@${host}:${port}/${databaseName}`;
    case 'mongodb':
      return `mongodb://${encodedUser}:${encodedPass}@${host}:${port}/${databaseName}`;
    case 'redis':
      return `redis://:${encodedPass}@${host}:${port}`;
    default:
      return '';
  }
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

    // Check database quota
    const org = await organizationRepository.findById(organizationId);
    if (!org) {
      throw new HTTPException(404, { message: t(locale, 'organizations', 'notFound') });
    }

    const plan = (org.plan || 'free') as PlanType;
    const planInfo = getPlanInfo(plan);
    const databaseLimit = planInfo.limits.databases;

    if (!isUnlimited(databaseLimit)) {
      const existingDatabases = await databaseRepository.findByOrganization(organizationId);
      if (existingDatabases.length >= databaseLimit) {
        throw new HTTPException(403, {
          message: t(locale, 'databases', 'quotaExceeded'),
        });
      }
    }

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

    return {
      ...database,
      password: '••••••••',
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
      const defaults = DATABASE_DEFAULTS[type];
      const containerName = `pushify-db-${databaseName}`;
      const dataDir = `/opt/pushify/databases/${databaseName}`;

      // Create data directory
      await ssh.exec(`mkdir -p ${dataDir}`);

      // Build docker run command based on database type
      let dockerCmd = '';
      switch (type) {
        case 'postgresql':
          dockerCmd = `docker run -d --name ${containerName} \
            -p 127.0.0.1:${containerPort}:5432 \
            -e POSTGRES_USER=${username} \
            -e POSTGRES_PASSWORD=${password} \
            -e POSTGRES_DB=${databaseName} \
            -v ${dataDir}:/var/lib/postgresql/data \
            --restart unless-stopped \
            ${defaults.image}:${version}`;
          break;

        case 'mysql':
          dockerCmd = `docker run -d --name ${containerName} \
            -p 127.0.0.1:${containerPort}:3306 \
            -e MYSQL_ROOT_PASSWORD=${password} \
            -e MYSQL_USER=${username} \
            -e MYSQL_PASSWORD=${password} \
            -e MYSQL_DATABASE=${databaseName} \
            -v ${dataDir}:/var/lib/mysql \
            --restart unless-stopped \
            ${defaults.image}:${version}`;
          break;

        case 'redis':
          dockerCmd = `docker run -d --name ${containerName} \
            -p 127.0.0.1:${containerPort}:6379 \
            -v ${dataDir}:/data \
            --restart unless-stopped \
            ${defaults.image}:${version} redis-server --requirepass ${password}`;
          break;

        case 'mongodb':
          dockerCmd = `docker run -d --name ${containerName} \
            -p 127.0.0.1:${containerPort}:27017 \
            -e MONGO_INITDB_ROOT_USERNAME=${username} \
            -e MONGO_INITDB_ROOT_PASSWORD=${password} \
            -e MONGO_INITDB_DATABASE=${databaseName} \
            -v ${dataDir}:/data/db \
            --restart unless-stopped \
            ${defaults.image}:${version}`;
          break;
      }

      // Run the container
      await ssh.exec(dockerCmd);

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

    // Check name uniqueness if changing
    if (input.name && input.name !== database.name) {
      const existing = await databaseRepository.findByName(organizationId, input.name);
      if (existing) {
        throw new HTTPException(400, { message: t(locale, 'databases', 'nameExists') });
      }
    }

    const updated = await databaseRepository.update(databaseId, input);
    return {
      ...updated,
      password: '••••••••',
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

    // Delete database record
    await databaseRepository.delete(databaseId);
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
    if (!membership) {
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

    // Check if connection already exists
    const exists = await databaseRepository.connectionExists(databaseId, input.projectId);
    if (exists) {
      throw new HTTPException(400, { message: t(locale, 'databases', 'alreadyConnected') });
    }

    const connection = await databaseRepository.createConnection({
      databaseId,
      projectId: input.projectId,
      envVarName: input.envVarName || 'DATABASE_URL',
      permissions: input.permissions || 'readwrite',
    });

    return connection;
  },

  // Disconnect database from project
  async disconnectFromProject(
    connectionId: string,
    organizationId: string,
    userId: string,
    locale: SupportedLocale
  ) {
    const membership = await organizationRepository.findMember(organizationId, userId);
    if (!membership) {
      throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
    }

    const connection = await databaseRepository.findConnectionById(connectionId);
    if (!connection) {
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
      const defaults = DATABASE_DEFAULTS[database.type];
      const dataDir = `/opt/pushify/databases/${database.databaseName}`;
      const password = decrypt(database.password);
      const bindAddress = externalAccess ? '0.0.0.0' : '127.0.0.1';

      // Stop and remove existing container
      await ssh.exec(`docker stop ${containerName} || true`);
      await ssh.exec(`docker rm ${containerName} || true`);

      // Recreate with new port binding
      let dockerCmd = '';
      switch (database.type) {
        case 'postgresql':
          dockerCmd = `docker run -d --name ${containerName} \
            -p ${bindAddress}:${containerPort}:5432 \
            -e POSTGRES_USER=${database.username} \
            -e POSTGRES_PASSWORD=${password} \
            -e POSTGRES_DB=${database.databaseName} \
            -v ${dataDir}:/var/lib/postgresql/data \
            --restart unless-stopped \
            ${defaults.image}:${database.version}`;
          break;

        case 'mysql':
          dockerCmd = `docker run -d --name ${containerName} \
            -p ${bindAddress}:${containerPort}:3306 \
            -e MYSQL_ROOT_PASSWORD=${password} \
            -e MYSQL_USER=${database.username} \
            -e MYSQL_PASSWORD=${password} \
            -e MYSQL_DATABASE=${database.databaseName} \
            -v ${dataDir}:/var/lib/mysql \
            --restart unless-stopped \
            ${defaults.image}:${database.version}`;
          break;

        case 'redis':
          dockerCmd = `docker run -d --name ${containerName} \
            -p ${bindAddress}:${containerPort}:6379 \
            -v ${dataDir}:/data \
            --restart unless-stopped \
            ${defaults.image}:${database.version} redis-server --requirepass ${password}`;
          break;

        case 'mongodb':
          dockerCmd = `docker run -d --name ${containerName} \
            -p ${bindAddress}:${containerPort}:27017 \
            -e MONGO_INITDB_ROOT_USERNAME=${database.username} \
            -e MONGO_INITDB_ROOT_PASSWORD=${password} \
            -e MONGO_INITDB_DATABASE=${database.databaseName} \
            -v ${dataDir}:/data/db \
            --restart unless-stopped \
            ${defaults.image}:${database.version}`;
          break;
      }

      await ssh.exec(dockerCmd);

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

    if (!database.serverId) {
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
      const containerName = database.containerName;

      switch (database.type) {
        case 'postgresql':
          await ssh.exec(`docker exec ${containerName} psql -U ${database.username} -c "ALTER USER ${database.username} PASSWORD '${newPassword}';"`);
          break;

        case 'mysql':
          const oldPassword = decrypt(database.password);
          await ssh.exec(`docker exec ${containerName} mysql -u root -p'${oldPassword}' -e "ALTER USER '${database.username}'@'%' IDENTIFIED BY '${newPassword}'; FLUSH PRIVILEGES;"`);
          break;

        case 'redis':
          await ssh.exec(`docker exec ${containerName} redis-cli CONFIG SET requirepass "${newPassword}"`);
          break;

        case 'mongodb':
          await ssh.exec(`docker exec ${containerName} mongosh admin --eval "db.changeUserPassword('${database.username}', '${newPassword}')"`);
          break;
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
