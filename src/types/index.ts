import type { Context } from 'hono';
import type { SupportedLocale } from '../i18n';

// App environment type for Hono context
export type AppEnv = {
  Variables: {
    requestId: string;
    locale: SupportedLocale;
    userId?: string;
    organizationId?: string;
    /** set by the API key middleware when the caller authenticated with pk_live_... */
    isApiKeyAuth?: boolean;
    apiKey?: { id: string; scopes: string };
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
