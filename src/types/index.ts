import type { Context } from 'hono';
import type { SupportedLocale } from '../i18n';

// App environment type for Hono context
export type AppEnv = {
  Variables: {
    requestId: string;
    locale: SupportedLocale;
    userId?: string;
    organizationId?: string;
  };
};

// Typed context for controllers
export type AppContext = Context<AppEnv>;

// WebSocket types
export type {
  WSEvent,
  WSEventType,
  WSClientMessage,
  WSServerMessage,
  DeploymentStatusEvent,
  DeploymentCreatedEvent,
  MetricsUpdateEvent,
  ServerStatusEvent,
  HealthCheckResultEvent,
  NotificationNewEvent,
} from './ws';
