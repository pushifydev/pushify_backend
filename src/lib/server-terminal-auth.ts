import { and, eq } from 'drizzle-orm';
import { db } from '../db';
import { servers } from '../db/schema/servers';
import { organizationMembers } from '../db/schema';
import { decrypt } from './encryption';

export class ServerTerminalAuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly httpStatus = 403,
  ) {
    super(message);
    this.name = 'ServerTerminalAuthError';
  }
}

export interface AuthorizedServerTerminal {
  serverId: string;
  host: string;
  username: string;
  privateKey: string;
}

export async function authorizeServerTerminalAccess(
  serverId: string,
  userId: string,
): Promise<AuthorizedServerTerminal> {
  const server = await db.query.servers.findFirst({
    where: eq(servers.id, serverId),
  });

  if (!server) {
    throw new ServerTerminalAuthError('Server not found', 'NOT_FOUND', 404);
  }

  const member = await db.query.organizationMembers.findFirst({
    where: and(
      eq(organizationMembers.organizationId, server.organizationId),
      eq(organizationMembers.userId, userId),
    ),
  });

  if (!member || !['owner', 'admin'].includes(member.role)) {
    throw new ServerTerminalAuthError(
      'Only owners and admins can use the terminal',
      'FORBIDDEN',
      403,
    );
  }

  if (server.status !== 'running') {
    throw new ServerTerminalAuthError('Server is not running', 'SERVER_NOT_RUNNING', 400);
  }

  if (server.setupStatus !== 'completed') {
    throw new ServerTerminalAuthError(
      'Server setup is not completed yet',
      'SERVER_NOT_READY',
      400,
    );
  }

  if (!server.ipv4 || !server.sshPrivateKey) {
    throw new ServerTerminalAuthError(
      'Server is not accessible via SSH',
      'SSH_UNAVAILABLE',
      400,
    );
  }

  return {
    serverId: server.id,
    host: server.ipv4,
    username: 'root',
    privateKey: decrypt(server.sshPrivateKey),
  };
}
