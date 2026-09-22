import type { DatabaseType } from '../db/schema/databases';
import { shSingleQuote } from '../workers/shell';

/**
 * Managed databases run as `pushify-db-<name>` containers on the organization's own server,
 * published on 127.0.0.1 only (the public address only with "external access"). Apps on the
 * same server reach them over the `pushify` Docker network by container name — the address in
 * `connectionString` (server IP + host port) is for tools outside the server and does not work
 * from inside an app container while external access is off.
 */

export const DATABASE_NETWORK = 'pushify';

export const DATABASE_DEFAULTS: Record<DatabaseType, { version: string; port: number; image: string }> = {
  postgresql: { version: '16', port: 5432, image: 'postgres' },
  mysql: { version: '8.0', port: 3306, image: 'mysql' },
  redis: { version: '7', port: 6379, image: 'redis' },
  mongodb: { version: '7', port: 27017, image: 'mongo' },
};

/** Same log rotation / privilege limits as app containers; images drop to their own user via gosu. */
export const DATABASE_CONTAINER_HARDENING =
  ' --cap-drop NET_RAW --security-opt no-new-privileges --log-driver json-file --log-opt max-size=10m --log-opt max-file=3';

export function isDatabaseType(value: unknown): value is DatabaseType {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DATABASE_DEFAULTS, value);
}

/** An image tag: `16`, `8.0`, `7-alpine`. It is spliced into a root shell command. */
export function validateDatabaseVersion(value: string): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(value)) {
    return 'Version may only contain letters, digits and . _ - (e.g. 16 or 8.0)';
  }
  return null;
}

/** The variable a linked database is exposed as in the app — a plain POSIX name. */
export function validateEnvVarName(value: string): string | null {
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(value)) {
    return 'Variable name may only contain letters, digits and _ and must not start with a digit';
  }
  return null;
}

export function buildConnectionString(
  type: DatabaseType,
  host: string,
  port: number,
  username: string,
  password: string,
  databaseName: string
): string {
  const encodedUser = encodeURIComponent(username);
  const encodedPass = encodeURIComponent(password);

  switch (type) {
    case 'postgresql':
      return `postgresql://${encodedUser}:${encodedPass}@${host}:${port}/${databaseName}`;
    case 'mysql':
      return `mysql://${encodedUser}:${encodedPass}@${host}:${port}/${databaseName}`;
    case 'mongodb':
      // The root user is created in `admin`; without authSource drivers authenticate against the app db.
      return `mongodb://${encodedUser}:${encodedPass}@${host}:${port}/${databaseName}?authSource=admin`;
    case 'redis':
      return `redis://:${encodedPass}@${host}:${port}`;
    default:
      return '';
  }
}

/** The address apps on the same server use: container name + the database's own port. */
export function internalConnectionString(database: {
  type: DatabaseType;
  containerName: string;
  username: string;
  databaseName: string;
}, password: string): string {
  return buildConnectionString(
    database.type,
    database.containerName,
    DATABASE_DEFAULTS[database.type].port,
    database.username,
    password,
    database.databaseName
  );
}

export function databaseDataDir(databaseName: string): string {
  return `/opt/pushify/databases/${databaseName}`;
}

/**
 * `docker run` for a managed database: on the `pushify` network (reachable from apps by name),
 * published on 127.0.0.1 — or 0.0.0.0 with external access — at `hostPort`.
 */
export function buildDatabaseRunCommand(options: {
  type: DatabaseType;
  version: string;
  containerName: string;
  hostPort: number;
  externalAccess: boolean;
  databaseName: string;
  username: string;
  password: string;
}): string {
  const { type, version, containerName, hostPort, externalAccess, databaseName, username, password } = options;
  const defaults = DATABASE_DEFAULTS[type];
  const q = shSingleQuote;
  const bind = externalAccess ? '0.0.0.0' : '127.0.0.1';
  const dataDir = databaseDataDir(databaseName);

  const base =
    `docker run -d --name ${q(containerName)} --network ${DATABASE_NETWORK}` +
    ` --restart unless-stopped${DATABASE_CONTAINER_HARDENING}` +
    ` -p ${bind}:${hostPort}:${defaults.port}`;
  const image = q(`${defaults.image}:${version}`);

  switch (type) {
    case 'postgresql':
      return `${base} -e ${q(`POSTGRES_USER=${username}`)} -e ${q(`POSTGRES_PASSWORD=${password}`)} -e ${q(`POSTGRES_DB=${databaseName}`)} -v ${q(`${dataDir}:/var/lib/postgresql/data`)} ${image}`;
    case 'mysql':
      return `${base} -e ${q(`MYSQL_ROOT_PASSWORD=${password}`)} -e ${q(`MYSQL_USER=${username}`)} -e ${q(`MYSQL_PASSWORD=${password}`)} -e ${q(`MYSQL_DATABASE=${databaseName}`)} -v ${q(`${dataDir}:/var/lib/mysql`)} ${image}`;
    case 'redis':
      return `${base} -v ${q(`${dataDir}:/data`)} ${image} redis-server --requirepass ${q(password)}`;
    case 'mongodb':
      return `${base} -e ${q(`MONGO_INITDB_ROOT_USERNAME=${username}`)} -e ${q(`MONGO_INITDB_ROOT_PASSWORD=${password}`)} -e ${q(`MONGO_INITDB_DATABASE=${databaseName}`)} -v ${q(`${dataDir}:/data/db`)} ${image}`;
  }
}

/**
 * Create (or re-point) the read-only user projects connected as "readonly" get. Idempotent, so it
 * also repairs grants. The SQL / JS goes through a quoted here-doc: nothing in it is expanded by
 * the shell. Identifiers are generated ([a-z0-9_]) and passwords base64url. Redis has no
 * practical read-only mode (its ACLs don't survive a restart here) — callers refuse it.
 */
export function buildReadonlyUserCommand(options: {
  type: Exclude<DatabaseType, 'redis'>;
  containerName: string;
  /** The database's own user (owner; root in MySQL is created with the same password) */
  username: string;
  password: string;
  databaseName: string;
  readonlyUsername: string;
  readonlyPassword: string;
}): string {
  const { type, containerName, username, password, databaseName, readonlyUsername: ro, readonlyPassword: roPw } = options;
  const c = shSingleQuote(containerName);
  switch (type) {
    case 'postgresql':
      return `docker exec -i ${c} psql -q -v ON_ERROR_STOP=1 -U ${shSingleQuote(username)} -d ${shSingleQuote(databaseName)} <<'PUSHIFY_SQL'
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = '${ro}') THEN
    ALTER ROLE "${ro}" LOGIN PASSWORD '${roPw}';
  ELSE
    CREATE ROLE "${ro}" LOGIN PASSWORD '${roPw}';
  END IF;
END $$;
ALTER ROLE "${ro}" SET default_transaction_read_only = on;
GRANT CONNECT ON DATABASE "${databaseName}" TO "${ro}";
GRANT USAGE ON SCHEMA public TO "${ro}";
GRANT SELECT ON ALL TABLES IN SCHEMA public TO "${ro}";
GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO "${ro}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${username}" GRANT SELECT ON TABLES TO "${ro}";
ALTER DEFAULT PRIVILEGES FOR ROLE "${username}" GRANT SELECT ON SEQUENCES TO "${ro}";
PUSHIFY_SQL`;
    case 'mysql':
      return `docker exec -i -e MYSQL_PWD=${shSingleQuote(password)} ${c} mysql -u root <<'PUSHIFY_SQL'
CREATE USER IF NOT EXISTS '${ro}'@'%' IDENTIFIED BY '${roPw}';
ALTER USER '${ro}'@'%' IDENTIFIED BY '${roPw}';
GRANT SELECT, SHOW VIEW ON \`${databaseName}\`.* TO '${ro}'@'%';
FLUSH PRIVILEGES;
PUSHIFY_SQL`;
    case 'mongodb':
      return `docker exec -i ${c} mongosh --quiet -u ${shSingleQuote(username)} -p ${shSingleQuote(password)} --authenticationDatabase admin admin <<'PUSHIFY_JS'
const roles = [{ role: 'read', db: '${databaseName}' }];
if (db.getUser('${ro}')) { db.updateUser('${ro}', { pwd: '${roPw}', roles: roles }); } else { db.createUser({ user: '${ro}', pwd: '${roPw}', roles: roles }); }
print('PUSHIFY_RO_OK');
PUSHIFY_JS`;
  }
}

export interface LinkedDatabase {
  envVarName: string;
  /** Connected read-only: username / password below are the read-only user's */
  readonly?: boolean;
  name: string;
  type: DatabaseType;
  serverId: string | null;
  containerName: string | null;
  username: string;
  databaseName: string;
  externalAccess: boolean;
  /** Decrypted */
  password: string;
  /** Decrypted public connection string (server IP + host port) */
  connectionString: string | null;
}

/**
 * What a deploy to `targetServerId` gets from the project's linked databases: one variable per
 * link, the internal address when the database lives on the same server, the public one when it
 * lives elsewhere with external access on. A variable the project sets itself always wins.
 */
export function planLinkedDatabaseEnv(
  links: LinkedDatabase[],
  targetServerId: string,
  explicitKeys: Set<string>
): { vars: Record<string, string>; notes: string[] } {
  const vars: Record<string, string> = {};
  const notes: string[] = [];

  for (const link of links) {
    if (explicitKeys.has(link.envVarName)) {
      notes.push(`${link.envVarName} is set in the project's environment variables — keeping it instead of database "${link.name}"`);
      continue;
    }
    if (vars[link.envVarName]) {
      notes.push(`${link.envVarName} is already provided by another linked database — skipping "${link.name}"`);
      continue;
    }
    if (link.serverId === targetServerId && link.containerName) {
      vars[link.envVarName] = internalConnectionString(
        { type: link.type, containerName: link.containerName, username: link.username, databaseName: link.databaseName },
        link.password
      );
      notes.push(`${link.envVarName} → database "${link.name}" (${link.containerName}, private network${link.readonly ? ', read-only' : ''})`);
    } else if (link.externalAccess && link.connectionString) {
      vars[link.envVarName] = link.connectionString;
      notes.push(`${link.envVarName} → database "${link.name}" (another server, over its public address${link.readonly ? ', read-only' : ''})`);
    } else {
      notes.push(
        `Database "${link.name}" is on another server without external access — ${link.envVarName} not set. Deploy the project to that server or enable external access.`
      );
    }
  }

  return { vars, notes };
}
