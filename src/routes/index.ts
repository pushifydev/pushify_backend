import type { OpenAPIHono } from '@hono/zod-openapi';
import { healthRoutes } from './health';
import { authRoutes } from './auth';
import { projectRoutes } from './projects';
import { envVarRoutes } from './envvars';
import { domainRoutes } from './domains';
import { deploymentRoutes } from './deployments';
import { githubRoutes } from './github';
import { gitlabRoutes } from './gitlab';
import { webhookRoutes } from './webhooks';
import { notificationRoutes } from './notifications';
import { scheduledTaskRoutes } from './scheduled-tasks';
import { projectVolumeRoutes } from './project-volumes';
import { projectLogsRoutes } from './project-logs';
import { wakeRoutes, projectWakeRoutes } from './wake';
import { healthCheckRoutes } from './healthchecks';
import { previewRoutes } from './previews';
import { metricsRoutes } from './metrics';
import { apiKeyRoutes } from './apikeys';
import { activityRoutes } from './activity';
import { twoFactorRoutes } from './twoFactor';
import { organizationRoutes } from './organizations';
import { billingRoutes } from './billing';
import { serverRoutes } from './servers';
import { databaseRoutes } from './databases';
import { aiRoutes } from './ai';
import { cliAuthRoutes } from './cli-auth';
import { marketplaceRoutes } from './marketplace';
import { siteStudioRoutes } from './site-studio';
import { siteEditorRoutes } from './site-editor';
import { dashboardRoutes } from './dashboard';
import { alertsRoutes } from './alerts';

export function registerRoutes(app: OpenAPIHono<any>) {
  // API v1 routes
  app.route('/api/v1/health', healthRoutes);
  app.route('/api/v1/auth', authRoutes);
  app.route('/api/v1/auth/2fa', twoFactorRoutes);
  app.route('/api/v1/api-keys', apiKeyRoutes);
  // Sub-routers with specific paths must be registered BEFORE the generic
  // project router, otherwise /{projectId} catches /overview, etc.
  app.route('/api/v1/projects', metricsRoutes);
  app.route('/api/v1/projects', siteEditorRoutes);
  app.route('/api/v1/projects', notificationRoutes);
  app.route('/api/v1/projects', scheduledTaskRoutes);
  app.route('/api/v1/projects', projectVolumeRoutes);
  app.route('/api/v1/projects', projectLogsRoutes);
  app.route('/api/v1/projects', projectWakeRoutes);
  app.route('/api/v1/wake', wakeRoutes);
  app.route('/api/v1/projects', healthCheckRoutes);
  app.route('/api/v1/projects', previewRoutes);
  app.route('/api/v1/projects', projectRoutes);
  app.route('/api/v1/projects/:projectId/env', envVarRoutes);
  app.route('/api/v1/projects/:projectId/domains', domainRoutes);
  app.route('/api/v1/projects/:projectId/deployments', deploymentRoutes);
  app.route('/api/v1/activity', activityRoutes);
  app.route('/api/v1/organizations', organizationRoutes);
  app.route('/api/v1/billing', billingRoutes);
  app.route('/api/v1/dashboard', dashboardRoutes);
  app.route('/api/v1/alerts', alertsRoutes);
  app.route('/api/v1/servers', serverRoutes);
  app.route('/api/v1/databases', databaseRoutes);
  app.route('/api/v1/integrations/github', githubRoutes);
  app.route('/api/v1/integrations/gitlab', gitlabRoutes);

  app.route('/api/v1/ai', aiRoutes);
  app.route('/api/v1/auth/cli', cliAuthRoutes);
  app.route('/api/v1/marketplace', marketplaceRoutes);
  app.route('/api/v1/site-studio', siteStudioRoutes);

  // Webhook routes (no auth required - verified by signature)
  app.route('/api/v1/webhooks', webhookRoutes);
}
