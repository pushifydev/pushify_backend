// ============ Channel Prefix ============

export const WS_CHANNEL_PREFIX = 'ws:';

// ============ Event Types ============

export type WSEventType =
  | 'deployment:status'
  | 'deployment:created'
  | 'metrics:update'
  | 'server:status'
  | 'server:setup'
  | 'healthcheck:result'
  | 'notification:new'
  | 'backup:status';

// ============ Event Payloads ============

export interface DeploymentStatusEvent {
  projectId: string;
  deploymentId: string;
  status: string;
  message?: string;
}

export interface DeploymentCreatedEvent {
  projectId: string;
  deploymentId: string;
  branch?: string;
  trigger: string;
}

export interface MetricsUpdateEvent {
  projectId: string;
  cpuPercent: number;
  memoryPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export interface ServerStatusEvent {
  serverId: string;
  status: string;
  ipv4?: string;
  setupStatus?: string;
  statusMessage?: string;
}

export interface HealthCheckResultEvent {
  projectId: string;
  healthy: boolean;
  responseTimeMs?: number;
  consecutiveFailures: number;
}

export interface NotificationNewEvent {
  type: string;
  title: string;
  message: string;
  projectId?: string;
}

export interface BackupStatusEvent {
  databaseId: string;
  backupId: string;
  status: 'creating' | 'completed' | 'failed' | 'restoring' | 'restored';
  sizeMb?: number;
  errorMessage?: string;
}

// ============ Discriminated Union ============

export type WSEvent =
  | { type: 'deployment:status'; data: DeploymentStatusEvent }
  | { type: 'deployment:created'; data: DeploymentCreatedEvent }
  | { type: 'metrics:update'; data: MetricsUpdateEvent }
  | { type: 'server:status'; data: ServerStatusEvent }
  | { type: 'server:setup'; data: ServerStatusEvent }
  | { type: 'healthcheck:result'; data: HealthCheckResultEvent }
  | { type: 'notification:new'; data: NotificationNewEvent }
  | { type: 'backup:status'; data: BackupStatusEvent };

// ============ Client → Server Messages ============

export type WSClientMessage =
  | { action: 'subscribe'; channel: string }
  | { action: 'unsubscribe'; channel: string }
  | { action: 'ping' };

// ============ Server → Client Messages ============

export type WSServerMessage =
  | { type: 'event'; event: WSEvent; channel: string }
  | { type: 'subscribed'; channel: string }
  | { type: 'unsubscribed'; channel: string }
  | { type: 'error'; message: string }
  | { type: 'pong' }
  | { type: 'connected'; clientId: string };
