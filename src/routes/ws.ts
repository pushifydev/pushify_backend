import { Hono } from 'hono';
import type { createNodeWebSocket } from '@hono/node-ws';
import { verifyToken } from '../lib/jwt';
import { wsManager } from '../lib/ws';
import { logger } from '../lib/logger';
import { randomUUID } from 'crypto';
import type { WSClientMessage } from '../types/ws';
import { isUserBanned } from '../lib/user-ban';
import {
  isOrganizationTwoFactorRequired,
  orgTwoFactorRequiredWsError,
  recordOrgTwoFactorDenial,
  userHasTwoFactorEnabled,
} from '../lib/org-two-factor';
import type { SupportedLocale } from '../i18n';

export function createWSRoute(
  upgradeWebSocket: ReturnType<typeof createNodeWebSocket>['upgradeWebSocket']
) {
  const wsRoute = new Hono();

  wsRoute.get(
    '/',
    upgradeWebSocket((c) => {
      const token = c.req.query('token');
      const locale: SupportedLocale = c.get('locale') || 'en';
      let clientId = '';
      let authenticated = false;

      return {
        onOpen: async (_event, ws) => {
          if (!token) {
            ws.send(JSON.stringify({ type: 'error', message: 'Missing token' }));
            ws.close(4001, 'Unauthorized');
            return;
          }

          try {
            const payload = await verifyToken(token);
            if (payload.type !== 'access') {
              ws.send(JSON.stringify({ type: 'error', message: 'Invalid token type' }));
              ws.close(4001, 'Unauthorized');
              return;
            }
            if (payload.sub && (await isUserBanned(payload.sub))) {
              ws.send(JSON.stringify({ type: 'error', message: 'Account suspended' }));
              ws.close(4003, 'Forbidden');
              return;
            }
            // Organization-wide 2FA (lib/org-two-factor), as authMiddleware does for requests
            if (
              payload.org &&
              (await isOrganizationTwoFactorRequired(payload.org)) &&
              !(payload.sub && (await userHasTwoFactorEnabled(payload.sub)))
            ) {
              if (payload.sub) {
                await recordOrgTwoFactorDenial({
                  organizationId: payload.org,
                  userId: payload.sub,
                  accessPath: 'websocket',
                  path: c.req.path,
                  ipAddress: c.req.header('x-forwarded-for') || c.req.header('x-real-ip'),
                  userAgent: c.req.header('user-agent'),
                });
              }
              ws.send(JSON.stringify(orgTwoFactorRequiredWsError(locale)));
              ws.close(4003, 'Forbidden');
              return;
            }

            clientId = randomUUID();
            authenticated = true;

            wsManager.addClient(clientId, ws, payload.sub!, payload.org || '');
            ws.send(JSON.stringify({ type: 'connected', clientId }));
          } catch (error) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid or expired token' }));
            ws.close(4001, 'Unauthorized');
          }
        },

        onMessage: (event, ws) => {
          if (!authenticated) return;

          try {
            const raw = typeof event.data === 'string' ? event.data : event.data.toString();
            const message: WSClientMessage = JSON.parse(raw);

            switch (message.action) {
              case 'subscribe':
                if ('channel' in message && message.channel) {
                  wsManager.subscribe(clientId, message.channel);
                }
                break;
              case 'unsubscribe':
                if ('channel' in message && message.channel) {
                  wsManager.unsubscribe(clientId, message.channel);
                }
                break;
              case 'ping':
                wsManager.handlePong(clientId);
                ws.send(JSON.stringify({ type: 'pong' }));
                break;
            }
          } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format' }));
          }
        },

        onClose: () => {
          if (clientId) wsManager.removeClient(clientId);
        },

        onError: (error) => {
          logger.error({ error, clientId }, 'WebSocket error');
          if (clientId) wsManager.removeClient(clientId);
        },
      };
    })
  );

  return wsRoute;
}
