import { Hono } from 'hono';
import type { createNodeWebSocket } from '@hono/node-ws';
import { verifyToken } from '../lib/jwt';
import { logger } from '../lib/logger';
import { SSHShellSession } from '../lib/ssh-shell-session';
import {
  authorizeServerTerminalAccess,
  authorizeProjectShellAccess,
  ServerTerminalAuthError,
} from '../lib/server-terminal-auth';

/**
 * Remote command that attaches to the project's running app container: resolves the
 * blue/green/plain container name on the host, then docker-execs an interactive shell
 * (bash when the image has it, sh otherwise). Slug is validated to [a-z0-9-] upstream.
 */
function buildAppShellCommand(slug: string): string {
  const resolve =
    `c=$(docker ps --format "{{.Names}}" | grep -E "^pushify-${slug}(-blue|-green)?$" | head -1); ` +
    `[ -z "$c" ] && c=$(docker ps --format "{{.Names}}" | grep -E "^pushify-${slug}(-|$)" | head -1); `;
  const attach =
    `if [ -n "$c" ]; then exec docker exec -it "$c" sh -c "command -v bash >/dev/null 2>&1 && exec bash || exec sh"; ` +
    `else echo "App container is not running - deploy the project first."; exit 1; fi`;
  return `sh -c '${resolve}${attach}'`;
}

const MAX_SESSIONS = 50;
const activeSessions = new Set<SSHShellSession>();

type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' };

function sendJson(ws: { send: (data: string) => void }, payload: Record<string, unknown>): void {
  ws.send(JSON.stringify(payload));
}

function parseClientMessage(raw: string | ArrayBuffer): ClientMessage | null {
  try {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const msg = JSON.parse(text) as ClientMessage;
    if (msg.type === 'input' && typeof msg.data === 'string') return msg;
    if (msg.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
      return msg;
    }
    if (msg.type === 'ping') return msg;
    return null;
  } catch {
    return null;
  }
}

export function createServerTerminalWSRoute(
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>['upgradeWebSocket'],
): Hono {
  const route = new Hono();

  route.get(
    '/servers/:serverId/terminal',
    upgradeWebSocket((c) => {
      const serverId = c.req.param('serverId');
      const token = c.req.query('token');
      let shell: SSHShellSession | null = null;
      let opened = false;

      return {
        onOpen: async (_event, ws) => {
          if (activeSessions.size >= MAX_SESSIONS) {
            sendJson(ws, { type: 'error', message: 'Too many active terminal sessions' });
            ws.close(1013, 'Try again later');
            return;
          }

          if (!token) {
            sendJson(ws, { type: 'error', message: 'Missing token' });
            ws.close(4001, 'Unauthorized');
            return;
          }

          try {
            const payload = await verifyToken(token);
            if (payload.type !== 'access' || !payload.sub) {
              sendJson(ws, { type: 'error', message: 'Invalid token' });
              ws.close(4001, 'Unauthorized');
              return;
            }

            const access = await authorizeServerTerminalAccess(serverId, payload.sub);

            shell = new SSHShellSession();
            activeSessions.add(shell);

            const cols = Math.min(Math.max(parseInt(c.req.query('cols') || '120', 10) || 120, 20), 500);
            const rows = Math.min(Math.max(parseInt(c.req.query('rows') || '32', 10) || 32, 5), 200);

            await shell.connect(
              {
                host: access.host,
                port: 22,
                username: access.username,
                privateKey: access.privateKey,
              },
              { cols, rows, term: 'xterm-256color' },
              {
                onData: (chunk) => {
                  if (!opened) return;
                  sendJson(ws, { type: 'output', data: chunk.toString('utf8') });
                },
                onClose: () => {
                  sendJson(ws, { type: 'exit' });
                  ws.close(1000, 'Shell closed');
                },
                onError: (err) => {
                  logger.warn({ err, serverId }, 'SSH shell session error');
                  sendJson(ws, { type: 'error', message: err.message });
                },
              },
            );

            opened = true;
            sendJson(ws, { type: 'ready', cols, rows });
            logger.info({ serverId, userId: payload.sub }, 'Web terminal session started');
          } catch (err) {
            const message =
              err instanceof ServerTerminalAuthError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : 'Failed to open terminal';
            sendJson(ws, { type: 'error', message });
            ws.close(4003, 'Terminal unavailable');
          }
        },

        onMessage: (event, ws) => {
          if (!shell || !opened) return;

          const msg = parseClientMessage(event.data as string | ArrayBuffer);
          if (!msg) {
            sendJson(ws, { type: 'error', message: 'Invalid message' });
            return;
          }

          if (msg.type === 'input') {
            shell.write(msg.data);
          } else if (msg.type === 'resize') {
            shell.resize(msg.cols, msg.rows);
          } else if (msg.type === 'ping') {
            sendJson(ws, { type: 'pong' });
          }
        },

        onClose: () => {
          if (shell) {
            activeSessions.delete(shell);
            shell.disconnect();
            shell = null;
          }
          logger.debug({ serverId }, 'Web terminal session closed');
        },

        onError: (error) => {
          logger.error({ error, serverId }, 'Web terminal WebSocket error');
          if (shell) {
            activeSessions.delete(shell);
            shell.disconnect();
            shell = null;
          }
        },
      };
    }),
  );

  // Web shell INTO a project's app container (docker exec over SSH on the project's
  // server/runner). Same message protocol as the server terminal.
  route.get(
    '/projects/:projectId/shell',
    upgradeWebSocket((c) => {
      const projectId = c.req.param('projectId');
      const token = c.req.query('token');
      let shell: SSHShellSession | null = null;
      let opened = false;

      return {
        onOpen: async (_event, ws) => {
          if (activeSessions.size >= MAX_SESSIONS) {
            sendJson(ws, { type: 'error', message: 'Too many active terminal sessions' });
            ws.close(1013, 'Try again later');
            return;
          }

          if (!token) {
            sendJson(ws, { type: 'error', message: 'Missing token' });
            ws.close(4001, 'Unauthorized');
            return;
          }

          try {
            const payload = await verifyToken(token);
            if (payload.type !== 'access' || !payload.sub) {
              sendJson(ws, { type: 'error', message: 'Invalid token' });
              ws.close(4001, 'Unauthorized');
              return;
            }

            const access = await authorizeProjectShellAccess(projectId, payload.sub);

            shell = new SSHShellSession();
            activeSessions.add(shell);

            const cols = Math.min(Math.max(parseInt(c.req.query('cols') || '120', 10) || 120, 20), 500);
            const rows = Math.min(Math.max(parseInt(c.req.query('rows') || '32', 10) || 32, 5), 200);

            await shell.connect(
              {
                host: access.host,
                port: 22,
                username: access.username,
                privateKey: access.privateKey,
              },
              { cols, rows, term: 'xterm-256color' },
              {
                onData: (chunk) => {
                  if (!opened) return;
                  sendJson(ws, { type: 'output', data: chunk.toString('utf8') });
                },
                onClose: () => {
                  sendJson(ws, { type: 'exit' });
                  ws.close(1000, 'Shell closed');
                },
                onError: (err) => {
                  logger.warn({ err, projectId }, 'App shell session error');
                  sendJson(ws, { type: 'error', message: err.message });
                },
              },
              buildAppShellCommand(access.projectSlug),
            );

            opened = true;
            sendJson(ws, { type: 'ready', cols, rows });
            logger.info({ projectId, userId: payload.sub }, 'App shell session started');
          } catch (err) {
            const message =
              err instanceof ServerTerminalAuthError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : 'Failed to open shell';
            sendJson(ws, { type: 'error', message });
            ws.close(4003, 'Shell unavailable');
          }
        },

        onMessage: (event, ws) => {
          if (!shell || !opened) return;

          const msg = parseClientMessage(event.data as string | ArrayBuffer);
          if (!msg) {
            sendJson(ws, { type: 'error', message: 'Invalid message' });
            return;
          }

          if (msg.type === 'input') {
            shell.write(msg.data);
          } else if (msg.type === 'resize') {
            shell.resize(msg.cols, msg.rows);
          } else if (msg.type === 'ping') {
            sendJson(ws, { type: 'pong' });
          }
        },

        onClose: () => {
          if (shell) {
            activeSessions.delete(shell);
            shell.disconnect();
            shell = null;
          }
          logger.debug({ projectId }, 'App shell session closed');
        },

        onError: (error) => {
          logger.error({ error, projectId }, 'App shell WebSocket error');
          if (shell) {
            activeSessions.delete(shell);
            shell.disconnect();
            shell = null;
          }
        },
      };
    }),
  );

  return route;
}

export function closeAllTerminalSessions(): void {
  for (const session of activeSessions) {
    session.disconnect();
  }
  activeSessions.clear();
}
