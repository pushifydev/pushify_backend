import { Redis } from 'ioredis';
import { randomUUID } from 'crypto';
import { logger } from './logger';
import { env } from '../config/env';
import type { WSEvent, WSServerMessage, WSClientMessage } from '../types/ws';

const WS_CHANNEL_PREFIX = 'ws:';
const HEARTBEAT_INTERVAL = 30000;
const HEARTBEAT_TIMEOUT = 10000;

interface WSClient {
  ws: any;
  clientId: string;
  userId: string;
  organizationId: string;
  subscriptions: Set<string>;
  lastPong: number;
}

class WebSocketManager {
  private clients = new Map<string, WSClient>();
  private redisSubscriber: Redis | null = null;
  private redisPublisher: Redis | null = null;
  private subscribedChannels = new Set<string>();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  initialize() {
    if (!env.REDIS_URL) {
      logger.warn('Redis not configured — WebSocket runs in local-only mode');
      this.startHeartbeat();
      return;
    }

    try {
      this.redisSubscriber = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

      this.redisPublisher = new Redis(env.REDIS_URL, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
      });

      this.redisSubscriber.on('message', (redisChannel: string, message: string) => {
        const channel = redisChannel.replace(WS_CHANNEL_PREFIX, '');
        this.broadcastToChannel(channel, message);
      });

      this.redisSubscriber.on('error', (err) => {
        logger.error({ err }, 'Redis subscriber error');
      });

      this.redisPublisher.on('error', (err) => {
        logger.error({ err }, 'Redis publisher error');
      });

      logger.info('WebSocket manager initialized with Redis pub/sub');
    } catch (err) {
      logger.error({ err }, 'Failed to initialize Redis for WebSocket — falling back to local mode');
    }

    this.startHeartbeat();
  }

  // ============ Client Management ============

  addClient(clientId: string, ws: any, userId: string, organizationId: string) {
    this.clients.set(clientId, {
      ws,
      clientId,
      userId,
      organizationId,
      subscriptions: new Set(),
      lastPong: Date.now(),
    });

    // Auto-subscribe to org channel
    this.subscribe(clientId, `org:${organizationId}`);

    logger.info({ clientId, userId, clients: this.clients.size }, 'WS client connected');
  }

  removeClient(clientId: string) {
    const client = this.clients.get(clientId);
    if (!client) return;

    for (const channel of client.subscriptions) {
      this.maybeUnsubscribeRedis(channel);
    }

    this.clients.delete(clientId);
    logger.info({ clientId, clients: this.clients.size }, 'WS client disconnected');
  }

  // ============ Subscriptions ============

  subscribe(clientId: string, channel: string) {
    const client = this.clients.get(clientId);
    if (!client) return;

    if (!this.canAccessChannel(client, channel)) {
      this.sendTo(clientId, { type: 'error', message: `Access denied: ${channel}` });
      return;
    }

    client.subscriptions.add(channel);
    this.subscribeRedis(channel);
    this.sendTo(clientId, { type: 'subscribed', channel });
  }

  unsubscribe(clientId: string, channel: string) {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Don't allow unsubscribing from own org channel
    if (channel === `org:${client.organizationId}`) return;

    client.subscriptions.delete(channel);
    this.maybeUnsubscribeRedis(channel);
    this.sendTo(clientId, { type: 'unsubscribed', channel });
  }

  handlePong(clientId: string) {
    const client = this.clients.get(clientId);
    if (client) client.lastPong = Date.now();
  }

  // ============ Publishing (called by workers) ============

  async publish(channel: string, event: WSEvent) {
    const message = JSON.stringify(event);

    if (this.redisPublisher) {
      try {
        await this.redisPublisher.publish(`${WS_CHANNEL_PREFIX}${channel}`, message);
      } catch (err) {
        logger.error({ err, channel }, 'Redis publish failed, broadcasting locally');
        this.broadcastToChannel(channel, message);
      }
    } else {
      // No Redis — broadcast directly
      this.broadcastToChannel(channel, message);
    }
  }

  // ============ Stats ============

  getClientCount(): number {
    return this.clients.size;
  }

  // ============ Shutdown ============

  async shutdown() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    for (const client of this.clients.values()) {
      try {
        client.ws.close(1001, 'Server shutting down');
      } catch {}
    }
    this.clients.clear();

    if (this.redisSubscriber) {
      try { await this.redisSubscriber.quit(); } catch {}
    }
    if (this.redisPublisher) {
      try { await this.redisPublisher.quit(); } catch {}
    }

    logger.info('WebSocket manager shut down');
  }

  // ============ Private ============

  private broadcastToChannel(channel: string, rawMessage: string) {
    for (const client of this.clients.values()) {
      if (client.subscriptions.has(channel)) {
        try {
          const event = JSON.parse(rawMessage) as WSEvent;
          const msg: WSServerMessage = { type: 'event', event, channel };
          client.ws.send(JSON.stringify(msg));
        } catch (err) {
          logger.error({ err, clientId: client.clientId }, 'Failed to send WS message');
        }
      }
    }
  }

  private subscribeRedis(channel: string) {
    if (!this.redisSubscriber) return;
    const redisChannel = `${WS_CHANNEL_PREFIX}${channel}`;
    if (!this.subscribedChannels.has(redisChannel)) {
      this.redisSubscriber.subscribe(redisChannel);
      this.subscribedChannels.add(redisChannel);
    }
  }

  private maybeUnsubscribeRedis(channel: string) {
    if (!this.redisSubscriber) return;
    const redisChannel = `${WS_CHANNEL_PREFIX}${channel}`;

    // Only unsubscribe if no other clients need this channel
    const stillNeeded = Array.from(this.clients.values()).some(
      (c) => c.subscriptions.has(channel)
    );

    if (!stillNeeded && this.subscribedChannels.has(redisChannel)) {
      this.redisSubscriber.unsubscribe(redisChannel);
      this.subscribedChannels.delete(redisChannel);
    }
  }

  private canAccessChannel(client: WSClient, channel: string): boolean {
    if (channel.startsWith('org:')) {
      return channel === `org:${client.organizationId}`;
    }
    // project/server channels: trust org membership
    return true;
  }

  private sendTo(clientId: string, message: WSServerMessage) {
    const client = this.clients.get(clientId);
    if (!client) return;
    try {
      client.ws.send(JSON.stringify(message));
    } catch (err) {
      logger.error({ err, clientId }, 'Failed to send to WS client');
      this.removeClient(clientId);
    }
  }

  private startHeartbeat() {
    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [clientId, client] of this.clients) {
        if (now - client.lastPong > HEARTBEAT_INTERVAL + HEARTBEAT_TIMEOUT) {
          logger.info({ clientId }, 'WS heartbeat timeout');
          try { client.ws.close(1000, 'Heartbeat timeout'); } catch {}
          this.removeClient(clientId);
        } else {
          try {
            client.ws.send(JSON.stringify({ type: 'pong' } as WSServerMessage));
          } catch {}
        }
      }
    }, HEARTBEAT_INTERVAL);
  }
}

export const wsManager = new WebSocketManager();
