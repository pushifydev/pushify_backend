/**
 * Shared session plumbing for every studio engine.
 *
 * Access control, the pooled SSH connection and `docker exec` are identical whether the database
 * is PostgreSQL, MySQL, MongoDB or Redis — only the client and the script differ. Each engine's
 * service builds a command and hands it here.
 */
import { HTTPException } from 'hono/http-exception';
import { eq } from 'drizzle-orm';
import { databaseRepository } from '../repositories/database.repository';
import { organizationRepository } from '../repositories/organization.repository';
import { t, type SupportedLocale } from '../i18n';
import { decrypt } from '../lib/encryption';
import { getSSHConnection, type SSHClient, type SSHConnectionConfig } from '../utils/ssh';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { logger } from '../lib/logger';
import { StudioValidationError } from '../lib/studio-errors';
import type { DatabaseType } from '../db/schema/databases';

/** What a caller is about to do with the data. */
export type StudioAccessLevel = 'read' | 'write';

/**
 * Owners and admins always have full access. Everyone else gets what the organisation granted
 * them, which defaults to none — so nothing changes for an organisation that never opts in.
 */
export function resolveStudioAccess(membership: {
  role: string;
  studioAccess?: 'none' | 'read' | 'write' | null;
}): 'none' | 'read' | 'write' {
  if (membership.role === 'owner' || membership.role === 'admin') return 'write';
  return membership.studioAccess ?? 'none';
}

export function satisfies(granted: 'none' | 'read' | 'write', required: StudioAccessLevel): boolean {
  if (granted === 'write') return true;
  return granted === 'read' && required === 'read';
}

export interface StudioSessionBase {
  ssh: SSHClient;
  /** kept so a pooled connection that died between requests can be re-established */
  connectConfig: SSHConnectionConfig;
  type: DatabaseType;
  containerName: string;
  username: string;
  databaseName: string;
  password: string;
  databaseId: string;
  databaseLabel: string;
}

/**
 * Open a session against a running database container, after checking the caller may touch it.
 * `allowedTypes` is the engine gate — the studio for one engine never opens another's.
 */
export async function openStudioSession(
  databaseId: string,
  organizationId: string,
  userId: string,
  allowedTypes: DatabaseType[],
  locale: SupportedLocale,
  required: StudioAccessLevel = 'write'
): Promise<StudioSessionBase> {
  const membership = await organizationRepository.findMember(organizationId, userId);
  if (!membership) {
    throw new HTTPException(403, { message: t(locale, 'errors', 'forbidden') });
  }

  const granted = resolveStudioAccess(membership);
  if (!satisfies(granted, required)) {
    throw new HTTPException(403, {
      message: t(locale, 'databases', granted === 'read' ? 'studioReadOnlyAccess' : 'studioNoAccess'),
    });
  }

  const database = await databaseRepository.findById(databaseId);
  if (!database || database.organizationId !== organizationId) {
    throw new HTTPException(404, { message: t(locale, 'databases', 'notFound') });
  }

  if (!allowedTypes.includes(database.type)) {
    throw new HTTPException(400, { message: t(locale, 'databases', 'studioUnsupportedEngine') });
  }

  if (database.status !== 'running') {
    throw new HTTPException(400, { message: t(locale, 'databases', 'mustBeRunning') });
  }

  if (!database.serverId || !database.containerName) {
    throw new HTTPException(400, { message: t(locale, 'databases', 'invalidContainer') });
  }

  const server = await db.query.servers.findFirst({ where: eq(servers.id, database.serverId) });
  if (!server?.ipv4 || !server.sshPrivateKey) {
    throw new HTTPException(400, { message: t(locale, 'servers', 'notProvisioned') });
  }

  // Pooled: the SSH handshake costs more than the query itself, and the studio is interactive.
  const connectConfig: SSHConnectionConfig = {
    host: server.ipv4,
    username: 'root',
    privateKey: decrypt(server.sshPrivateKey),
  };
  const ssh = await getSSHConnection(connectConfig);

  return {
    ssh,
    connectConfig,
    type: database.type,
    containerName: database.containerName,
    username: database.username,
    databaseName: database.databaseName,
    password: decrypt(database.password),
    databaseId: database.id,
    databaseLabel: database.name,
  };
}

/**
 * Run `fn` against a session. The SSH connection is owned by the pool and is never closed here.
 * This is also the single place where the engine layers' validation errors become HTTP responses.
 */
export async function withStudioSession<S extends StudioSessionBase, T>(
  open: () => Promise<S>,
  locale: SupportedLocale,
  fn: (session: S) => Promise<T>
): Promise<T> {
  const session = await open();

  try {
    return await fn(session);
  } catch (error) {
    if (error instanceof StudioValidationError) {
      throw new HTTPException(400, { message: t(locale, 'databases', error.key) });
    }
    throw error;
  }
}

export interface ContainerExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Send a prepared shell command to the server, reconnecting first if the pool handed us a corpse. */
export async function execOnServer(
  session: StudioSessionBase,
  command: string
): Promise<ContainerExecResult> {
  // A pooled connection can go away between requests; re-acquire before sending rather than
  // retrying afterwards, which could apply a write twice.
  if (!session.ssh.isConnected()) {
    session.ssh = await getSSHConnection(session.connectConfig);
  }

  const result = await session.ssh.exec(command);

  if (result.code !== 0 && result.stderr) {
    logger.debug(
      { databaseId: session.databaseId, code: result.code },
      'studio container command exited non-zero'
    );
  }

  return result;
}
